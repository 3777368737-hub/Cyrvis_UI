/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';

import type { ToolContext, ToolDefinition, ToolResult } from './types';

const CONDITION_KINDS = [
  'path_exists',
  'path_missing',
  'path_is_file',
  'path_is_directory',
  'process_running',
  'process_missing',
  'window_exists',
  'window_missing',
] as const;

type ConditionKind = (typeof CONDITION_KINDS)[number];

const PATH_CONDITIONS = new Set<ConditionKind>([
  'path_exists',
  'path_missing',
  'path_is_file',
  'path_is_directory',
]);

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key].trim() : fallback);

const number = (
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
};

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
  data?: unknown,
): ToolResult => ({
  ok: false,
  tool,
  speech,
  data,
  error: { code, message: speech },
});

const matchesText = (candidate: string, query: string): boolean =>
  candidate.toLowerCase().includes(query.toLowerCase());

const evaluateCondition = async (
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ met: boolean; detail: Record<string, unknown> }> => {
  const kind = String(args.kind) as ConditionKind;
  const target = String(args.target);
  if (PATH_CONDITIONS.has(kind)) {
    try {
      const stats = await fs.stat(target);
      const met =
        kind === 'path_exists'
          ? true
          : kind === 'path_missing'
            ? false
            : kind === 'path_is_file'
              ? stats.isFile()
              : stats.isDirectory();
      return {
        met,
        detail: {
          kind,
          target,
          exists: true,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      return {
        met: kind === 'path_missing',
        detail: { kind, target, exists: false },
      };
    }
  }

  if (kind === 'process_running' || kind === 'process_missing') {
    const processes = await context.desktop.listProcesses();
    const matched = processes.find(
      (entry) =>
        matchesText(entry.name, target) ||
        Boolean(entry.title && matchesText(entry.title, target)),
    );
    return {
      met: kind === 'process_running' ? Boolean(matched) : !matched,
      detail: {
        kind,
        target,
        matched: matched || null,
        processCount: processes.length,
      },
    };
  }

  const windows = await context.desktop.listWindows();
  const matched = windows.find(
    (entry) =>
      matchesText(entry.title, target) || matchesText(entry.process, target),
  );
  return {
    met: kind === 'window_exists' ? Boolean(matched) : !matched,
    detail: {
      kind,
      target,
      matched: matched || null,
      windowCount: windows.length,
    },
  };
};

const prepareConditionArgs = (
  input: Record<string, unknown>,
  context: ToolContext,
) => {
  const kind = text(input, 'kind') as ConditionKind;
  if (!CONDITION_KINDS.includes(kind)) {
    throw new Error(`Unsupported condition kind: ${kind}`);
  }
  const rawTarget = text(input, 'target');
  if (!rawTarget) {
    throw new Error('target is required');
  }
  return {
    kind,
    target: PATH_CONDITIONS.has(kind)
      ? context.resolvePath(rawTarget)
      : rawTarget,
  };
};

const prepareWaitArgs = (
  input: Record<string, unknown>,
  context: ToolContext,
) => {
  const condition = prepareConditionArgs(input, context);
  return {
    ...condition,
    timeoutMs: number(input, 'timeoutMs', 10_000, 100, 120_000),
    intervalMs: number(input, 'intervalMs', 250, 50, 2_000),
  };
};

export const CONDITION_TOOLS: ToolDefinition[] = [
  {
    name: 'condition.check',
    domain: 'system',
    description:
      'Check whether a file, process, or window condition is currently true.',
    risk: 'low',
    capability: {
      providerId: 'automation',
      tier: 1,
      activation: 'always',
      priority: 81,
      tags: [
        'condition',
        'check',
        'verify',
        'assert',
        '状态',
        '检查',
        '验证',
        '断言',
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...CONDITION_KINDS] },
        target: { type: 'string' },
      },
      required: ['kind', 'target'],
      additionalProperties: false,
    },
    pathArgs: (args) =>
      PATH_CONDITIONS.has(args.kind as ConditionKind)
        ? [String(args.target)]
        : [],
    prepare: prepareConditionArgs,
    async execute(args, context) {
      const result = await evaluateCondition(args, context);
      return result.met
        ? success('condition.check', '条件已满足。', result.detail)
        : failure(
            'condition.check',
            '条件尚未满足。',
            'CONDITION_NOT_MET',
            result.detail,
          );
    },
  },
  {
    name: 'condition.wait',
    domain: 'system',
    description:
      'Wait until a file, process, or window condition becomes true or the timeout expires.',
    risk: 'low',
    capability: {
      providerId: 'automation',
      tier: 2,
      activation: 'on-demand',
      priority: 58,
      tags: ['wait', 'condition', 'timeout', '等待', '条件', '超时', '异步'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...CONDITION_KINDS] },
        target: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 100, maximum: 120_000 },
        intervalMs: { type: 'number', minimum: 50, maximum: 2_000 },
      },
      required: ['kind', 'target'],
      additionalProperties: false,
    },
    pathArgs: (args) =>
      PATH_CONDITIONS.has(args.kind as ConditionKind)
        ? [String(args.target)]
        : [],
    prepare: prepareWaitArgs,
    async execute(args, context) {
      const startedAt = Date.now();
      const timeoutMs = Number(args.timeoutMs);
      const intervalMs = Number(args.intervalMs);
      let lastDetail: Record<string, unknown> = {};
      while (Date.now() - startedAt <= timeoutMs) {
        const result = await evaluateCondition(args, context);
        lastDetail = result.detail;
        if (result.met) {
          return success('condition.wait', '条件已满足。', {
            ...result.detail,
            waitedMs: Date.now() - startedAt,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return failure('condition.wait', '等待条件超时。', 'CONDITION_TIMEOUT', {
        ...lastDetail,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
      });
    },
  },
];
