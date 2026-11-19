import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopHost, ToolContext } from '../tools/types';
import { createReminderTools, ReminderService } from './reminders';

afterEach(() => {
  vi.useRealTimers();
});

describe('local reminders', () => {
  it('creates and fires a one-shot desktop notification', async () => {
    vi.useFakeTimers();
    const notifications: Array<{ title: string; body: string }> = [];
    const desktop = {
      showNotification: vi.fn(async (title: string, body: string) => {
        notifications.push({ title, body });
      }),
    } as unknown as DesktopHost;
    const context: ToolContext = {
      cwd: process.cwd(),
      homeDirectory: os.homedir(),
      platform: process.platform,
      desktop,
      resolvePath: (value) => value,
    };
    const service = new ReminderService();
    const tools = createReminderTools(service).tools;
    const create = tools.find((tool) => tool.name === 'timer.create')!;
    const prepared = await create.prepare(
      {
        delaySeconds: 2,
        title: 'Tea',
        body: 'Ready',
      },
      context,
    );

    const result = await create.execute(prepared, context);
    expect(result.ok).toBe(true);
    expect(service.list()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(notifications).toEqual([{ title: 'Tea', body: 'Ready' }]);
    expect(service.list()).toHaveLength(0);
    service.dispose();
  });
});
