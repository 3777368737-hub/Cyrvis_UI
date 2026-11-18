import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

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

import type { StreamingAsrEvent } from '@shared/asrStream';
import {
  DashScopeStreamingAsrService,
  normalizeQwenStreamingAsrUrl,
} from './streamingAsr';

class FakeAsrSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];

  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send(
    data: string | Buffer,
    optionsOrCallback?: { binary?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ) {
    const done =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (Buffer.isBuffer(data)) {
      this.sent.push(data);
      done?.();
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            header: {
              event: 'result-generated',
              request_id: 'request-1',
            },
            payload: {
              output: {
                sentence: { text: '打开浏览器', end_time: 800 },
              },
            },
          }),
        ),
        false,
      );
      return;
    }
    const event = JSON.parse(data) as {
      header?: { action?: string; task_id?: string };
    };
    this.sent.push(event);
    done?.();
    if (event.header?.action === 'run-task') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              header: {
                event: 'task-started',
                task_id: event.header?.task_id,
              },
              payload: {},
            }),
          ),
          false,
        );
      });
    }
    if (event.header?.action === 'finish-task') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              header: {
                event: 'task-finished',
                task_id: event.header?.task_id,
              },
              payload: {},
            }),
          ),
          false,
        );
      });
    }
  }

  close() {
    this.readyState = 3;
  }
}

describe('DashScope streaming ASR', () => {
  it('normalizes streaming endpoints', () => {
    expect(normalizeQwenStreamingAsrUrl('https://dashscope.aliyuncs.com')).toBe(
      'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    );
  });

  it('claims a prepared session, forwards PCM, and finalizes text', async () => {
    let socket!: FakeAsrSocket;
    const events: StreamingAsrEvent[] = [];
    const service = new DashScopeStreamingAsrService({
      emit: (event) => events.push(event),
      getConfig: () => ({
        url: 'ws://127.0.0.1/test',
        apiKey: 'test-key',
        model: 'qwen-audio-3.1-asr-flash-streaming',
      }),
      createSocket: () => {
        socket = new FakeAsrSocket();
        return socket as never;
      },
    });

    const prepared = await service.prepare();
    expect(
      service.claim({
        sessionId: prepared.sessionId,
        turnId: 'turn-1',
      }).claimed,
    ).toBe(true);
    await service.sendAudio({
      sessionId: prepared.sessionId,
      audio: Uint8Array.from([1, 2, 3, 4]).buffer,
    });
    const result = await service.finish(prepared.sessionId);

    expect(result.text).toBe('打开浏览器');
    expect(socket.sent).toEqual(expect.arrayContaining([expect.any(Buffer)]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'started',
          sessionId: prepared.sessionId,
          turnId: 'turn-1',
        }),
        expect.objectContaining({
          type: 'partial',
          text: '打开浏览器',
        }),
        expect.objectContaining({
          type: 'final',
          text: '打开浏览器',
        }),
      ]),
    );
  });

  it('rejects a pending finalization when the session is cancelled', async () => {
    let socket!: FakeAsrSocket;
    const service = new DashScopeStreamingAsrService({
      getConfig: () => ({
        url: 'ws://127.0.0.1/test',
        apiKey: 'test-key',
        model: 'qwen-audio-3.1-asr-flash-streaming',
      }),
      createSocket: () => {
        socket = new FakeAsrSocket();
        return socket as never;
      },
    });
    const started = await service.start({ turnId: 'turn-cancel' });
    socket.send = (data, optionsOrCallback, callback) => {
      const done =
        typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      if (Buffer.isBuffer(data)) {
        socket.sent.push(data);
      } else {
        socket.sent.push(JSON.parse(data));
      }
      done?.();
    };

    const finishing = service.finish(started.sessionId);
    service.cancel(started.sessionId);
    await expect(finishing).rejects.toThrow('cancelled');
  });
});
