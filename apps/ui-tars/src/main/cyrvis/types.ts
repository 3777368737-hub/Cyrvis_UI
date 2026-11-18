/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StepUpdate, TaskSource } from '@shared/cyrvis';

export type {
  ControllerEvent,
  StepUpdate,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from '@shared/cyrvis';

export interface TaskRequest {
  taskId: string;
  instruction: string;
  source: TaskSource;
  createdAt: number;
}

export interface GUIAdapterCallbacks {
  onStarted: () => void;
  onStep: (step: StepUpdate) => void;
  onNeedsUser: (question: string) => void;
  onPaused: () => void;
  onResumed: () => void;
  onDone: (summary: string) => void;
  onFailed: (error: string) => void;
  onCancelled: () => void;
}

/**
 * Provider-independent GUI executor contract.
 * The real implementation wraps UI-TARS `runAgent`; tests can use a fake.
 */
export interface GUIAdapter {
  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export type VoiceToolCall =
  | {
      name: 'start_gui_task';
      args: { instruction: string; confidence?: number };
    }
  | { name: 'cancel_gui_task'; args: { task_id?: string } }
  | { name: 'pause_gui_task'; args: Record<string, never> }
  | { name: 'resume_gui_task'; args: Record<string, never> }
  | { name: 'get_gui_status'; args: Record<string, never> }
  | { name: 'remember_fact'; args: { text: string } }
  | {
      name: 'search_web';
      args: {
        query: string;
        engine?: 'bing' | 'baidu' | 'google';
        site?: string;
        task_instruction?: string;
      };
    }
  | {
      name: 'open_url';
      args: { url: string; task_instruction?: string };
    }
  | {
      name: 'open_app';
      args: {
        app: 'vscode' | 'chrome' | 'explorer' | 'notepad';
        target?: string;
        task_instruction?: string;
      };
    }
  | {
      name: 'open_site';
      args: { site: string; query?: string; task_instruction?: string };
    }
  | {
      name: 'confirm_action';
      args: { task_id: string; approved: boolean };
    };

export type ProactivityReason =
  | 'task_started'
  | 'task_stalled'
  | 'task_needs_user'
  | 'task_done'
  | 'task_failed'
  | 'task_cancelled'
  | 'progress'
  | 'suggestion';

export type ProactivityPriority = 0 | 1 | 2 | 3;

export interface ProactiveUtterance {
  text: string;
  priority: ProactivityPriority;
  reason: ProactivityReason;
}
