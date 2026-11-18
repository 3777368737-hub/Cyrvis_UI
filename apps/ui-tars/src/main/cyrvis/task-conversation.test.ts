/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskConversationCoordinator } from './task-conversation';
import type { TaskSnapshot } from './types';

const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  taskId: 'task-1',
  status: 'executing',
  instruction: '打开浏览器',
  source: 'voice',
  step: 2,
  lastSummary: '打开页面',
  error: null,
  startedAt: 1,
  endedAt: null,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskConversationCoordinator', () => {
  it('guarantees a task-start acknowledgment when the model stays silent', async () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot({ status: 'starting', step: 0 }),
    });

    coordinator.onEvent({
      type: 'task_started',
      taskId: 'task-1',
      instruction: '打开浏览器',
      source: 'voice',
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(spoken).toEqual(['好的，任务已开始，我会持续向你反馈进度。']);
  });

  it('does not duplicate a model response that arrives before the start fallback', async () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot(),
    });
    coordinator.onEvent({
      type: 'task_started',
      taskId: 'task-1',
      instruction: '打开浏览器',
      source: 'voice',
    });
    coordinator.noteAssistantOutput();
    await vi.advanceTimersByTimeAsync(700);
    expect(spoken).toEqual([]);
  });

  it('always reports needs-user, completion, and failure events', () => {
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot(),
    });
    coordinator.onEvent({
      type: 'task_needs_user',
      taskId: 'task-1',
      question: '要使用哪个浏览器？',
    });
    coordinator.onEvent({
      type: 'task_done',
      taskId: 'task-1',
      summary: '已经打开浏览器。',
    });
    coordinator.onEvent({
      type: 'task_failed',
      taskId: 'task-1',
      error: '网络不可用',
    });
    expect(spoken).toEqual([
      '要使用哪个浏览器？',
      '任务完成。已经打开浏览器。',
      '任务失败：网络不可用',
    ]);
  });

  it('describes the latest task status for spoken queries', () => {
    const coordinator = new TaskConversationCoordinator({
      speak: () => undefined,
      getStatus: () => snapshot(),
    });
    expect(coordinator.describeStatus()).toBe(
      '任务正在执行，第 2 步：打开页面。',
    );
  });
});
