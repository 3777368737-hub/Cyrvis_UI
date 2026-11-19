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
        'Fallback GUI task executor. Call this only when no cyrvis_* local fast tool or voice fast tool can complete the request, or when the request requires visual inspection, interaction with an existing app UI, login, popups, dragging, or other multi-step GUI work. For live search/information needs, call search_web first. Never call for greetings, thanks, identity questions, stable knowledge you can answer directly, or chit-chat.',
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
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Open a web search in the platform browser (Bing on Windows, Safari on macOS). Use it only when the user explicitly asks to search/look something up, needs live or time-sensitive information (prices, flights/hotels, weather, news, scores, opening hours, policies), asks about a specific place/business/official site, or asks you to verify a source. Do NOT use it for stable knowledge you can answer from memory (e.g. "介绍邓小平", "邓小平是谁", "B站怎么投币", "怎么安装 Node.js") — answer those directly. For bare navigation like "打开B站/打开淘宝", use open_site instead. If the user also wants you to read, compare, or click the results, set task_instruction so the GUI agent continues after the page opens.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "去巴黎的机票".',
          },
          engine: {
            type: 'string',
            enum: ['bing', 'baidu', 'google'],
            description:
              'Search engine; default is the platform default (Bing on Windows, Google on macOS).',
          },
          site: {
            type: 'string',
            description:
              'Optional site filter, e.g. "ctrip.com" or "taobao.com". The query becomes "<query> site:<site>".',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the results page opens, e.g. "查看携程的机票结果并告诉我前三个选项". Only include when the user wants page interaction.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        'Open an http/https URL directly in the default browser. Use this instead of GUI clicking when the user gives a URL or a known page to open. Optional task_instruction starts a GUI task after the page opens.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full http/https URL to open.',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the page opens, e.g. "在页面中查看搜索结果".',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        'Open a supported desktop app through the local tool registry. Use for opening VS Code, Chrome, Explorer, Notepad, Calculator, Paint or other supported app aliases. If the user wants work inside the app, set task_instruction so the GUI agent continues after it opens.',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Allowlisted application to open.',
          },
          target: {
            type: 'string',
            description:
              'Optional file/folder path or URL to open with the app.',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the app opens, e.g. "在 VS Code 中打开 main.ts 并修改端口".',
          },
        },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_site',
      description:
        'Open a known website (Bilibili, Taobao, JD, YouTube, Zhihu, Weibo, Xiaohongshu, Baidu, Google, Bing, GitHub) for bare navigation requests like "打开B站/打开淘宝/打开YouTube". Do NOT use search_web or GUI clicking for these. If the user also wants a search inside the site ("打开B站搜一下猫"), set query. If they want you to interact with the page afterwards, set task_instruction.',
      parameters: {
        type: 'object',
        properties: {
          site: {
            type: 'string',
            description:
              'Site id, alias, Chinese name, or domain, e.g. bilibili, B站, 淘宝, YouTube, github.com.',
          },
          query: {
            type: 'string',
            description:
              'Optional on-site search query, e.g. "猫" for "打开B站搜一下猫".',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the page opens, e.g. "在B站搜索并播放第一个视频".',
          },
        },
        required: ['site'],
      },
    },
  },
];
