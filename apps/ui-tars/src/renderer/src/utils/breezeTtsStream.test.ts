import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BREEZE_TTS_STREAM_FIRST_MAX_CHARS,
  BreezeStreamingPlayer,
  createBreezeEndMessage,
  createBreezeStartMessage,
  getAudioStartDelaySeconds,
  pcm16ToFloat32,
  takeTtsChunks,
} from './breezeTtsStream';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Renderer Breeze TTS player', () => {
  it('uses the TARS startup buffer and stable stream defaults', () => {
    expect(getAudioStartDelaySeconds(false)).toBe(0.1);
    expect(getAudioStartDelaySeconds(true)).toBe(0.02);
    expect(
      createBreezeStartMessage({
        wsUrl: 'ws://127.0.0.1:8138',
        voiceId: 'voice-1',
      }),
    ).toMatchObject({
      type: 'start',
      voice_id: 'voice-1',
      cfg_scale: 1,
      seed: 42,
      split_chars: 48,
    });
    expect(createBreezeEndMessage('结束。')).toEqual({
      type: 'end',
      text: '结束。',
    });
  });

  it('decodes PCM16 and caps the first chunk', () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setInt16(0, -32768, true);
    view.setInt16(2, 0, true);
    view.setInt16(4, 16384, true);
    view.setInt16(6, 32767, true);
    expect(Array.from(pcm16ToFloat32(buffer))).toEqual([
      -1,
      0,
      0.5,
      32767 / 32768,
    ]);
    expect(
      takeTtsChunks('a'.repeat(30), { firstChunk: true }).chunks[0],
    ).toHaveLength(BREEZE_TTS_STREAM_FIRST_MAX_CHARS);
  });

  it('connects to the Breeze WebSocket and closes its audio context', async () => {
    class MockWebSocket {
      static readonly OPEN = 1;
      readyState = MockWebSocket.OPEN;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          setTimeout(() => this.onmessage?.({ data: '{"type":"ready"}' }), 0);
        }, 0);
      }
      send(data: string) {
        const message = JSON.parse(data) as { type?: string };
        if (message.type === 'start') {
          setTimeout(() => this.onmessage?.({ data: '{"type":"started"}' }), 0);
        }
      }
      close() {
        this.readyState = 3;
      }
    }
    const contexts: Array<{ closed: boolean }> = [];
    class MockAudioContext {
      state = 'running';
      readonly record = { closed: false };
      constructor() {
        contexts.push(this.record);
      }
      async resume() {}
      async close() {
        this.record.closed = true;
      }
    }
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('AudioContext', MockAudioContext);

    const player = new BreezeStreamingPlayer({
      wsUrl: 'ws://127.0.0.1:8138',
    });
    await player.start();
    expect(contexts).toHaveLength(1);
    player.cancel();
    expect(contexts[0].closed).toBe(true);
  });
});
