import { describe, it, expect, vi, afterEach } from 'vitest';
import { ObjectMagnet, objectGaze, type GazeObject } from './objects';
import { GazeObjectTracker } from './object-tracker';
import { objectCrop } from './inspector';
const bounds = { x: -1440, y: 0, width: 1440, height: 900 };
const gaze = (at: number, x = 0.3, y = 0.3) => ({
  x,
  y,
  at,
  displayId: 1,
  bounds,
});
const card = (id = 'a', x = -1100): GazeObject => ({
  id,
  scene: 'window1',
  label: `专辑 ${id}`,
  role: 'AXImage',
  source: 'accessibility',
  bounds: { x, y: 200, width: 180, height: 180 },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe('object magnet', () => {
  it('acquires a real object across refreshes and keeps the whole target stable through boundary jitter', () => {
    const magnet = new ObjectMagnet();
    magnet.refresh([card(), card('b', -880)], 'window1', 0);
    expect(magnet.update(gaze(0), 0).phase).toBe('candidate');
    magnet.refresh([card(), card('b', -880)], 'window1', 650);
    expect(magnet.update(gaze(750), 750)).toMatchObject({
      phase: 'locked',
      target: { id: 'a' },
    });
    for (let at = 800; at < 1400; at += 50)
      expect(magnet.update(gaze(at, 0.365), at).target?.id).toBe('a');
    const locked = magnet.update(gaze(1400, 0.365), 1400);
    expect(objectGaze(gaze(1400), locked.target!).x).toBeCloseTo(
      (340 + 90) / 1440,
    );
  });
  it('requires sustained evidence to switch and never forces an ambiguous gap into a target', () => {
    const magnet = new ObjectMagnet();
    magnet.refresh([card(), card('b', -880)], 'window1', 0);
    const between = (at: number) => gaze(at, 540 / 1440, 290 / 900);
    expect(magnet.update(between(0), 0).phase).toBe('ambiguous');
    magnet.update(gaze(10), 10);
    expect(magnet.update(gaze(720), 720).target?.id).toBe('a');
    expect(magnet.update(gaze(800, 0.46), 800).target?.id).toBe('a');
    magnet.refresh([card(), card('b', -880)], 'window1', 1000);
    magnet.update(gaze(1100, 0.46), 1100);
    expect(magnet.update(gaze(1510, 0.46), 1510)).toMatchObject({
      phase: 'locked',
      target: { id: 'b' },
    });
  });
  it('releases stale scenes, scrolling geometry and missing faces instead of freezing a false lock', () => {
    const magnet = new ObjectMagnet();
    magnet.refresh([card()], 'window1', 0);
    magnet.update(gaze(0), 0);
    magnet.update(gaze(750), 750);
    magnet.refresh(
      [{ ...card(), bounds: { ...card().bounds, y: 400 } }],
      'window1',
      800,
    );
    expect(magnet.update(gaze(800), 800).phase).not.toBe('locked');
    magnet.refresh([{ ...card(), scene: 'window2' }], 'window2', 850);
    expect(magnet.update(gaze(850), 850).phase).not.toBe('locked');
    expect(magnet.update(gaze(3000), 3000).phase).toBe('searching');
    expect(magnet.update(null, 3100).phase).toBe('searching');
  });
  it('maps the chosen object into Retina screenshot pixels and preserves nearby captions', () => {
    const selected = objectGaze(gaze(0), card());
    expect(objectCrop(selected, 2880, 1800)).toEqual({
      x: 620,
      y: 340,
      width: 480,
      height: 570,
    });
  });
});
describe('object discovery lifecycle', () => {
  it('never lets a slow scan resurrect a disabled or lost gaze', async () => {
    vi.useFakeTimers();
    let finish!: (value: any) => void;
    const deps = {
      scan: vi.fn(
        () =>
          new Promise<any>((resolve) => {
            finish = resolve;
          }),
      ),
      render: vi.fn(),
      onGaze: vi.fn(),
      now: () => Date.now(),
    };
    const tracker = new GazeObjectTracker(deps);
    tracker.update(gaze(Date.now()));
    tracker.configure(false);
    finish({ scene: 'window1', objects: [card()] });
    await flush();
    expect(tracker.getStatus()).toMatchObject({
      enabled: false,
      phase: 'searching',
      objects: 0,
    });
    expect(deps.onGaze).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.anything() }),
    );
  });
  it('publishes object-centered context only after lock and clears it when samples stop', async () => {
    vi.useFakeTimers();
    const deps = {
      scan: vi.fn(async () => ({ scene: 'window1', objects: [card()] })),
      render: vi.fn(),
      onGaze: vi.fn(),
    };
    const tracker = new GazeObjectTracker(deps);
    for (let i = 0; i < 9; i++) {
      tracker.update(gaze(Date.now()));
      await flush();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(tracker.getStatus()).toMatchObject({
      phase: 'locked',
      target: { id: 'a' },
    });
    expect(deps.onGaze).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ id: 'a' }) }),
    );
    await vi.advanceTimersByTimeAsync(900);
    expect(tracker.getStatus().phase).toBe('searching');
    expect(deps.onGaze).toHaveBeenLastCalledWith(null);
  });
});
