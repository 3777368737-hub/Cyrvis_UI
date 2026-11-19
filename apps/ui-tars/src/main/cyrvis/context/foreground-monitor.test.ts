import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopHost, WindowInfo } from '../tools/types';
import { ForegroundMonitor } from './foreground-monitor';

afterEach(() => {
  vi.useRealTimers();
});

describe('ForegroundMonitor', () => {
  it('polls foreground changes without repeating unchanged windows', async () => {
    vi.useFakeTimers();
    let foreground: WindowInfo = {
      pid: 10,
      process: 'Code',
      title: 'one',
      handle: 1,
      focused: true,
    };
    const getForegroundWindow = vi.fn(async () => foreground);
    const desktop = { getForegroundWindow } as unknown as DesktopHost;
    const changes: WindowInfo[] = [];
    const monitor = new ForegroundMonitor(desktop, {
      intervalMs: 1_000,
      onChange: (window) => {
        if (window) changes.push(window);
      },
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.map((window) => window.title)).toEqual(['one']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(changes).toHaveLength(1);

    foreground = {
      pid: 20,
      process: 'Chrome',
      title: 'two',
      handle: 2,
      focused: true,
    };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changes.map((window) => window.title)).toEqual(['one', 'two']);
    monitor.stop();
  });
});
