import { describe, expect, it, vi } from 'vitest';
import { ProactiveGaze } from './proactive';
import { parseGazeSuggestion, resolveGazeReply } from './suggestions';

const music = () =>
  parseGazeSuggestion(
    JSON.stringify({
      kind: 'music',
      target: 'Day One',
      description: '你似乎在看《Day One》的封面',
      identified: true,
      confidence: 'high',
    }),
    100,
  )!;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  let now = 0;
  const deps = {
    inspect: vi.fn(async () => music()),
    cancel: vi.fn(),
    canInspect: vi.fn(() => true),
    onSuggestion: vi.fn(),
    now: () => now,
  };
  const controller = new ProactiveGaze(deps);
  const point = (at: number, x = 0.5, y = 0.5) => {
    now = at;
    controller.update({
      x,
      y,
      at,
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
  };
  const dwell = (start: number, x = 0.5) => {
    for (let at = start; at <= start + 4500; at += 500) point(at, x);
  };
  return {
    deps,
    controller,
    point,
    dwell,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe('proactive gaze', () => {
  it('does no work until enabled, then inspects only after sustained local dwell', async () => {
    const { controller, deps, point, dwell } = setup();
    dwell(0);
    expect(deps.inspect).not.toHaveBeenCalled();
    controller.configure(true);
    for (let at = 5000; at < 9500; at += 500)
      point(at, 0.5 + (at % 1000 ? 0.01 : 0));
    expect(deps.inspect).not.toHaveBeenCalled();
    point(9500);
    await flush();
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
    expect(controller.getStatus().suggestion?.gaze?.x).toBe(0.5);
  });
  it('resets dwell on target change, tracking loss and busy voice', () => {
    const { controller, deps, point } = setup();
    controller.configure(true);
    for (let at = 0; at <= 3000; at += 500) point(at);
    point(3500, 0.8);
    point(4000, 0.8);
    controller.update(null);
    for (let at = 4500; at <= 7500; at += 500) point(at, 0.8);
    deps.canInspect.mockReturnValue(false);
    for (let at = 8000; at <= 14_000; at += 500) point(at, 0.8);
    expect(deps.inspect).not.toHaveBeenCalled();
  });
  it('drops a completed result if the gaze moved or the feature was disabled', async () => {
    const { controller, deps, dwell, point } = setup();
    let finish!: (value: ReturnType<typeof music>) => void;
    deps.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.configure(true);
    dwell(0);
    point(5000, 0.9);
    controller.configure(false);
    finish(music());
    await flush();
    expect(deps.onSuggestion).not.toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('off');
    expect(deps.cancel).toHaveBeenCalled();
  });
  it('does not repeatedly inspect the same position or repeat the same target elsewhere', async () => {
    const { controller, deps, dwell, point } = setup();
    controller.configure(true);
    dwell(0);
    await flush();
    for (let at = 5000; at <= 70_000; at += 500) point(at);
    expect(deps.inspect).toHaveBeenCalledOnce();
    dwell(71_000, 0.8);
    await flush();
    expect(deps.inspect).toHaveBeenCalledTimes(2);
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
  });
  it('ignores stale and uncertain observations and backs off after errors', async () => {
    const { controller, deps, dwell, point } = setup();
    deps.inspect.mockRejectedValue(new Error('model unavailable'));
    controller.configure(true);
    dwell(0);
    await flush();
    for (let at = 5000; at <= 20_000; at += 500) point(at);
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(controller.getStatus().error).toBe('model unavailable');
  });
});
describe('grounded proactive suggestions', () => {
  it('offers music choices only for a clearly identified work and asks before acting', () => {
    const suggestion = music();
    expect(suggestion.actions.map((item) => item.kind)).toEqual([
      'play',
      'explain',
      'story',
    ]);
    expect(resolveGazeReply('播放它', suggestion)).toBe('play');
    expect(resolveGazeReply('讲讲封面背景', suggestion)).toBe('story');
    expect(resolveGazeReply('好', suggestion)).toBe('clarify');
    expect(resolveGazeReply('不用播放', suggestion)).toBe('dismiss');
    expect(resolveGazeReply('播放周杰伦的歌', suggestion)).toBeNull();
    expect(resolveGazeReply('介绍一下北京的历史', suggestion)).toBeNull();
  });
  it('does not offer playback or invent identity when a cover cannot be identified', () => {
    const suggestion = parseGazeSuggestion(
      '```json\n{"kind":"music","target":"","description":"这是一张音乐封面","identified":false,"confidence":"medium"}\n```',
      0,
    )!;
    expect(suggestion.actions.map((item) => item.kind)).toEqual(['explain']);
    expect(resolveGazeReply('播放', suggestion)).toBeNull();
    expect(
      parseGazeSuggestion(
        '{"kind":"image","description":"无法区分","confidence":"low"}',
        0,
      ),
    ).toBeNull();
  });
});
