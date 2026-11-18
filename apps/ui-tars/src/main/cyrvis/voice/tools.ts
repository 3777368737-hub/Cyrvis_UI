/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QwenToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const CYRVIS_VOICE_TOOLS: QwenToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'start_gui_task',
      description:
        'Fallback GUI task executor. Call this only when no cyrvis_* local fast tool can complete the request, or when the request requires visual inspection, interaction with an existing app UI, login, popups, dragging, or other multi-step GUI work. Prefer local file, app, window, clipboard, system, process, and web tools whenever their schemas fit. Never call for greetings, thanks, identity questions, or chit-chat.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'A clear, self-contained instruction for the GUI agent, including app name and target.',
          },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_gui_task',
      description:
        'Stop the currently running GUI task. Use when the user says stop, cancel, never mind, or asks to abort.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Optional task id; omit to cancel the active task.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_gui_task',
      description: 'Pause the currently running GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_gui_task',
      description: 'Resume the paused GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_gui_status',
      description:
        'Get the current GUI task status, progress, last step, and error. Use when the user asks what is happening or how far the task has gone.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Store a durable user preference, identity fact, or recurring context after the user explicitly asks you to remember it. Never store passwords, API keys, tokens, or other secrets.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'A concise, self-contained fact or preference to retain across sessions.',
          },
        },
        required: ['text'],
      },
    },
  },
];
