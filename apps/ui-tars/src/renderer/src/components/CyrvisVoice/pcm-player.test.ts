import { afterEach, expect, it, vi } from 'vitest';
import { PcmStreamPlayer } from './pcm-player';

class Source {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  disconnect = vi.fn();
  connect = vi.fn();
}
class Context {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: Source[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  setSinkId = vi.fn(async () => {});
  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
}
const setup = () => {
  const context = new Context();
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => context),
  );
  const idle = vi.fn(),
    error = vi.fn();
  return { context, idle, error, player: new PcmStreamPlayer(idle, error) };
};
afterEach(() => vi.unstubAllGlobals());

it('schedules every chunk contiguously without discarding a long buffered reply', async () => {
  const { context, player, idle } = setup();
  for (let i = 0; i < 12; i++) player.play(new Int16Array(12000));
  await Promise.resolve();
  player.finish();
  expect(context.sources).toHaveLength(12);
  for (let i = 1; i < context.sources.length; i++) {
    expect(context.sources[i].start.mock.calls[0][0]).toBeCloseTo(
      context.sources[i - 1].start.mock.calls[0][0] + 0.5,
    );
  }
  expect(idle).not.toHaveBeenCalled();
  context.sources.slice(0, 11).forEach((source) => source.onended?.());
  expect(idle).not.toHaveBeenCalled();
  context.sources[11].onended?.();
  expect(idle).toHaveBeenCalledTimes(1);
  expect(context.close).toHaveBeenCalledTimes(1);
});

it('waits for more data after an underrun and drains the short final tail', async () => {
  const { context, player, idle } = setup();
  player.play(new Int16Array(2400));
  await Promise.resolve();
  context.sources[0].onended?.();
  expect(idle).not.toHaveBeenCalled();
  context.currentTime = 2;
  player.play(new Int16Array(240));
  await Promise.resolve();
  player.finish();
  expect(context.sources[1].start.mock.calls[0][0]).toBeGreaterThanOrEqual(2);
  expect(context.sources[1].buffer?.duration).toBe(0.01);
  context.sources[1].onended?.();
  expect(idle).toHaveBeenCalledTimes(1);
});

it('cancels all queued audio without sending a stale idle event into the next response', async () => {
  const { context, player, idle } = setup();
  player.play(new Int16Array(24000));
  player.play(new Int16Array(24000));
  await Promise.resolve();
  player.stop();
  expect(
    context.sources.every((source) => source.stop.mock.calls.length === 1),
  ).toBe(true);
  context.sources.forEach((source) => source.onended?.());
  player.play(new Int16Array(24000));
  expect(context.sources).toHaveLength(2);
  expect(idle).not.toHaveBeenCalled();
});

it('does not start playback if stopped while resume is pending', async () => {
  const { context, player, idle } = setup();
  let resume!: () => void;
  context.state = 'suspended';
  context.resume.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  player.play(new Int16Array(24000));
  player.stop();
  resume();
  await Promise.resolve();
  expect(context.sources).toHaveLength(0);
  expect(idle).not.toHaveBeenCalled();
});

it('reports a playback failure and releases the microphone instead of silently hanging', async () => {
  const { context, player, idle, error } = setup();
  context.state = 'suspended';
  context.resume.mockRejectedValue(new Error('Output unavailable'));
  player.play(new Int16Array(24000));
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(idle).toHaveBeenCalledTimes(1);
  expect(player.isActive).toBe(false);
});

it('resumes a suspended clock after selecting an output and preserves all samples', async () => {
  const { context, player, idle } = setup();
  context.state = 'suspended';
  const selected = player.setSinkId('default');
  player.play(new Int16Array(24000));
  player.finish();
  await selected;
  await vi.waitFor(() => expect(context.sources).toHaveLength(1));
  expect(context.setSinkId).toHaveBeenCalledWith('');
  expect(context.resume).toHaveBeenCalledTimes(1);
  expect(idle).not.toHaveBeenCalled();
  context.sources[0].onended?.();
  expect(idle).toHaveBeenCalledTimes(1);
});
