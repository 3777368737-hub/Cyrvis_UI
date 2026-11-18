/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ControllerEvent, TaskSnapshot } from './types';

export interface TaskConversationCoordinatorOptions {
  speak: (text: string) => void;
  getStatus: () => TaskSnapshot;
  startAckDelayMs?: number;
  progressIntervalMs?: number;
  stalledCooldownMs?: number;
  now?: () => number;
}

export class TaskConversationCoordinator {
  private startAckTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOutputAt = 0;
  private lastProgressAt = 0;
  private lastStalledAt = 0;
  private lastStep = 0;
  private readonly startAckDelayMs: number;
  private readonly progressIntervalMs: number;
  private readonly stalledCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TaskConversationCoordinatorOptions) {
    this.startAckDelayMs = options.startAckDelayMs ?? 700;
    this.progressIntervalMs = options.progressIntervalMs ?? 10_000;
    this.stalledCooldownMs = options.stalledCooldownMs ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  noteAssistantOutput(): void {
    this.lastOutputAt = this.now();
    this.clearStartAck();
  }

  onEvent(event: ControllerEvent): void {
    const eventAt = this.now();
    switch (event.type) {
      case 'task_started': {
        this.clearStartAck();
        this.lastStep = 0;
        this.startAckTimer = setTimeout(() => {
          this.startAckTimer = null;
          if (this.lastOutputAt >= eventAt) {
            return;
          }
          this.options.speak('好的，任务已开始，我会持续向你反馈进度。');
        }, this.startAckDelayMs);
        break;
      }
      case 'step_update':
        if (
          event.step > this.lastStep &&
          eventAt - this.lastProgressAt >= this.progressIntervalMs
        ) {
          this.lastStep = event.step;
          this.lastProgressAt = eventAt;
          this.options.speak(
            `正在执行第 ${event.step} 步：${event.summary || '继续处理当前操作'}`,
          );
        }
        break;
      case 'task_stalled':
        if (eventAt - this.lastStalledAt >= this.stalledCooldownMs) {
          this.lastStalledAt = eventAt;
          this.options.speak(
            `任务还在处理，目前进行到第 ${event.step} 步，请稍等。`,
          );
        }
        break;
      case 'task_needs_user':
        this.clearStartAck();
        this.options.speak(event.question || '这里需要你确认一下。');
        break;
      case 'task_paused':
        this.options.speak('任务已暂停。');
        break;
      case 'task_resumed':
        this.options.speak('任务继续执行。');
        break;
      case 'task_done':
        this.clearStartAck();
        this.options.speak(
          event.summary.trim()
            ? `任务完成。${event.summary.trim()}`
            : '任务已经完成。',
        );
        break;
      case 'task_failed':
        this.clearStartAck();
        this.options.speak(`任务失败：${event.error}`);
        break;
      case 'task_cancelled':
        this.clearStartAck();
        this.options.speak('任务已取消。');
        break;
      default:
        break;
    }
  }

  describeStatus(): string {
    const task = this.options.getStatus();
    switch (task.status) {
      case 'starting':
        return '任务正在启动，还没有进入第一个执行步骤。';
      case 'executing':
        return `任务正在执行，第 ${task.step} 步${
          task.lastSummary ? `：${task.lastSummary}` : ''
        }。`;
      case 'paused':
        return `任务已暂停在第 ${task.step} 步。`;
      case 'cancelling':
        return '任务正在取消。';
      case 'done':
        return task.lastSummary
          ? `任务已完成：${task.lastSummary}`
          : '任务已经完成。';
      case 'failed':
        return `任务失败：${task.error || '未知错误'}`;
      case 'cancelled':
        return '任务已取消。';
      default:
        return '当前没有正在执行的任务。';
    }
  }

  reset(): void {
    this.clearStartAck();
    this.lastOutputAt = 0;
    this.lastProgressAt = 0;
    this.lastStalledAt = 0;
    this.lastStep = 0;
  }

  dispose(): void {
    this.clearStartAck();
  }

  private clearStartAck(): void {
    if (this.startAckTimer) {
      clearTimeout(this.startAckTimer);
      this.startAckTimer = null;
    }
  }
}
