import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WavStreamPlayer } from './wav-player';

let activeAudio: FakeAudio;

class FakeAudio {
  autoplay = false;
  currentTime = 0;
  src = '';
  style: Record<string, string> = {};
  listeners = new Map<string, () => void>();

  addEventListener = vi.fn((event: string, callback: () => void) => {
    this.listeners.set(event, callback);
  });

  pause = vi.fn();

  play = vi.fn(async () => undefined);

  remove = vi.fn();
}

describe('WavStreamPlayer', () => {
  beforeEach(() => {
    activeAudio = new FakeAudio();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => activeAudio),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes the remaining playback reference after resume', async () => {
    const onIdle = vi.fn();
    const onSegmentStart = vi.fn();
    const player = new WavStreamPlayer(onIdle, vi.fn(), onSegmentStart);

    player.play(new Int16Array(18000));
    await Promise.resolve();
    await Promise.resolve();

    expect(onSegmentStart).toHaveBeenCalledTimes(1);
    expect(onSegmentStart.mock.calls[0][0]).toHaveLength(18000);

    player.pause();
    activeAudio.currentTime = 0.25;
    player.resume();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSegmentStart).toHaveBeenCalledTimes(2);
    expect(onSegmentStart.mock.calls[1][0]).toHaveLength(12000);
  });

  it('can discard stale playback without reporting playback idle', () => {
    const onIdle = vi.fn();
    const player = new WavStreamPlayer(onIdle, vi.fn());

    player.play(new Int16Array(18000));
    player.stop(false);

    expect(onIdle).not.toHaveBeenCalled();
  });
});
