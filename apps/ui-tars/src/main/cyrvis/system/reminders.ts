import { randomUUID } from 'node:crypto';

import type { ToolDefinition, ToolResult } from '../tools/types';

interface Reminder {
  id: string;
  title: string;
  body: string;
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key] : fallback);

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  speech: string,
  code: string,
  message: string,
): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code, message },
});

const durationLabel = (seconds: number): string => {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3_600).toFixed(seconds % 3_600 ? 1 : 0)} 小时`;
};

export class ReminderService {
  private readonly reminders = new Map<string, Reminder>();

  schedule(
    delaySeconds: number,
    title: string,
    body: string,
    show: (title: string, body: string) => Promise<void>,
  ): Reminder {
    const id = randomUUID();
    const dueAt = Date.now() + delaySeconds * 1_000;
    const timer = setTimeout(() => {
      this.reminders.delete(id);
      void show(title, body).catch(() => undefined);
    }, delaySeconds * 1_000);
    timer.unref?.();
    const reminder = { id, title, body, dueAt, timer };
    this.reminders.set(id, reminder);
    return reminder;
  }

  cancel(id: string): Reminder | null {
    const reminder = this.reminders.get(id);
    if (!reminder) {
      return null;
    }
    clearTimeout(reminder.timer);
    this.reminders.delete(id);
    return reminder;
  }

  list(): Array<Omit<Reminder, 'timer'>> {
    return [...this.reminders.values()]
      .map(({ timer: _timer, ...reminder }) => reminder)
      .sort((left, right) => left.dueAt - right.dueAt);
  }

  dispose(): void {
    for (const reminder of this.reminders.values()) {
      clearTimeout(reminder.timer);
    }
    this.reminders.clear();
  }
}

export const createReminderTools = (
  service = new ReminderService(),
): { tools: ToolDefinition[]; service: ReminderService } => ({
  service,
  tools: [
    {
      name: 'system.notification',
      domain: 'system',
      description: 'Show a local desktop notification.',
      risk: 'low',
      capability: {
        providerId: 'system',
        tier: 2,
        activation: 'on-demand',
        priority: 57,
        permissions: ['system.read'],
        tags: ['notification', 'alert', '通知', '提醒'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      prepare: (input) => ({
        title: text(input, 'title', 'CYRVIS').slice(0, 120),
        body: text(input, 'body').slice(0, 1_000),
      }),
      async execute(args, context) {
        if (!context.desktop.showNotification) {
          return failure(
            'system.notification',
            '当前平台不支持系统通知。',
            'NOTIFICATION_UNSUPPORTED',
            'DesktopHost.showNotification is unavailable.',
          );
        }
        try {
          await context.desktop.showNotification(
            String(args.title),
            String(args.body),
          );
          return success('system.notification', '通知已发送。');
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return failure(
            'system.notification',
            `发送通知失败：${message}`,
            'NOTIFICATION_FAILED',
            message,
          );
        }
      },
    },
    {
      name: 'timer.create',
      domain: 'system',
      description:
        'Create a local one-shot reminder and show a desktop notification when due.',
      risk: 'low',
      capability: {
        providerId: 'system',
        tier: 2,
        activation: 'on-demand',
        priority: 60,
        permissions: ['system.read'],
        tags: ['timer', 'reminder', 'alarm', '计时器', '提醒', '闹钟'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          delaySeconds: { type: 'number', minimum: 1, maximum: 86400 },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['delaySeconds', 'title'],
        additionalProperties: false,
      },
      prepare: (input) => ({
        delaySeconds: Math.max(
          1,
          Math.min(86_400, Math.floor(Number(input.delaySeconds) || 1)),
        ),
        title: text(input, 'title', 'CYRVIS 提醒').slice(0, 120),
        body: text(input, 'body', text(input, 'title')).slice(0, 1_000),
      }),
      async execute(args, context) {
        if (!context.desktop.showNotification) {
          return failure(
            'timer.create',
            '当前平台无法显示定时提醒。',
            'TIMER_NOTIFICATION_UNSUPPORTED',
            'DesktopHost.showNotification is unavailable.',
          );
        }
        const reminder = service.schedule(
          Number(args.delaySeconds),
          String(args.title),
          String(args.body),
          (title, body) => context.desktop.showNotification!(title, body),
        );
        return success(
          'timer.create',
          `已设置 ${durationLabel(Number(args.delaySeconds))}后的提醒。`,
          reminderToData(reminder),
        );
      },
    },
    {
      name: 'timer.cancel',
      domain: 'system',
      description: 'Cancel a previously created local timer.',
      risk: 'low',
      capability: {
        providerId: 'system',
        tier: 2,
        activation: 'on-demand',
        priority: 54,
        permissions: ['system.read'],
        tags: ['timer', 'cancel', '计时器', '取消', '提醒'],
      },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      prepare: (input) => ({ id: text(input, 'id').trim() }),
      async execute(args) {
        const reminder = service.cancel(String(args.id));
        return reminder
          ? success('timer.cancel', '提醒已取消。', reminderToData(reminder))
          : failure(
              'timer.cancel',
              '没有找到对应的提醒。',
              'TIMER_NOT_FOUND',
              'Timer not found.',
            );
      },
    },
    {
      name: 'timer.list',
      domain: 'system',
      description: 'List active local timers and reminders.',
      risk: 'low',
      capability: {
        providerId: 'system',
        tier: 2,
        activation: 'on-demand',
        priority: 52,
        permissions: ['system.read'],
        tags: ['timer', 'list', '计时器', '列表', '提醒'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      async execute() {
        const reminders = service.list();
        return success(
          'timer.list',
          reminders.length
            ? `当前有 ${reminders.length} 个提醒。`
            : '当前没有提醒。',
          { reminders },
        );
      },
    },
  ],
});

const reminderToData = (
  reminder: Reminder,
): { id: string; title: string; body: string; dueAt: number } => ({
  id: reminder.id,
  title: reminder.title,
  body: reminder.body,
  dueAt: reminder.dueAt,
});
