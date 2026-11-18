import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    voiceQwenTtsApiKey: 'test-key',
    voiceQwenTtsHttpBaseUrl: 'https://dashscope.aliyuncs.com',
    voiceQwenTtsWsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    voiceQwenTtsWorkspace: '',
    voiceQwenTtsModel: 'qwen3-tts-flash-realtime',
    voiceQwenTtsVoice: 'Cherry',
    voiceQwenTtsVoiceModel: 'qwen3-tts-flash-realtime',
    voiceQwenTtsReferenceAudioPath: '',
    voiceQwenTtsPreferredName: 'cyrvis',
    voiceQwenTtsMode: 'commit',
    voiceQwenTtsLanguage: 'Chinese',
    voiceTtsApiKey: '',
    voiceTtsVoice: '',
    conversationApiKey: '',
  },
  set: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('@main/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: () => mocks.settings,
    set: mocks.set,
  },
}));

import type { QwenTtsRealtimeStreamEvent } from '@shared/qwenTtsRealtime';
import {
  normalizeQwenTtsWebSocketUrl,
  QwenTtsRealtimeService,
} from './qwenTtsRealtime';

class FakeTtsSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    queueMicrotask(() => {
      this.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'session.created' })),
        false,
      );
    });
  }

  send(data: string, callback?: (error?: Error) => void) {
    const event = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(event);
    callback?.();
    if (event.type === 'session.update') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'session.updated',
              session: { sample_rate: 24_000 },
            }),
          ),
          false,
        );
      });
    }
    if (event.type === 'session.finish') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(JSON.stringify({ type: 'session.finished' })),
          false,
        );
      });
    }
  }

  close() {
    this.readyState = 3;
  }
}

describe('Qwen realtime TTS', () => {
  it('builds protocol-specific WebSocket URLs', () => {
    expect(
      normalizeQwenTtsWebSocketUrl(
        'https://dashscope.aliyuncs.com',
        'qwen3-tts-flash-realtime',
      ),
    ).toContain('/api-ws/v1/realtime?model=');
    expect(
      normalizeQwenTtsWebSocketUrl(
        'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        'qwen-audio-3.1-tts-flash',
      ),
    ).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  });

  it('streams timestamped text and forwards PCM deltas', async () => {
    let socket!: FakeTtsSocket;
    const events: QwenTtsRealtimeStreamEvent[] = [];
    const service = new QwenTtsRealtimeService({
      emit: (event) => events.push(event),
      createSocket: () => {
        socket = new FakeTtsSocket();
        return socket as never;
      },
    });

    const started = await service.start({ requestId: 'turn-1' });
    await service.append({
      sessionId: started.sessionId,
      text: '你好。',
      commit: true,
    });
    expect(socket.sent.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'session.update',
        'input_text_buffer.append',
        'input_text_buffer.commit',
      ]),
    );

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.audio.delta',
          delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
        }),
      ),
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'audio',
        sessionId: started.sessionId,
        sampleRate: 24_000,
      }),
    );

    await service.finish(started.sessionId);
    expect(events).toContainEqual({
      type: 'completed',
      sessionId: started.sessionId,
    });
  });

  it('resolves an in-flight finish promise when a response is cancelled', async () => {
    let socket!: FakeTtsSocket;
    const service = new QwenTtsRealtimeService({
      createSocket: () => {
        socket = new FakeTtsSocket();
        return socket as never;
      },
    });
    const started = await service.start({ requestId: 'turn-cancel' });
    socket.send = (data, callback) => {
      socket.sent.push(JSON.parse(data));
      callback?.();
    };

    const finishing = service.finish(started.sessionId);
    service.cancel(started.sessionId);
    await expect(finishing).resolves.toBeUndefined();
  });
});
