/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from './types';

const asString = (
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; fallback?: string } = {},
): string => {
  const value = input[key];
  if (typeof value === 'string') {
    return value;
  }
  if (options.required) {
    throw new Error(`${key} is required`);
  }
  return options.fallback ?? '';
};

export const OFFICE_TOOLS: ToolDefinition[] = [
  {
    name: 'office.create_presentation',
    domain: 'office',
    description:
      'Create a native PowerPoint presentation with an initial title slide using the installed Microsoft PowerPoint application. The path may use desktop/downloads/documents aliases or an absolute .pptx path.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => {
      const requestedPath = context.resolvePath(
        asString(input, 'path', { required: true }),
      );
      const extension = path.extname(requestedPath).toLowerCase();
      const target =
        extension === '.pptx'
          ? requestedPath
          : `${requestedPath.replace(/\.pptx?$/i, '')}.pptx`;
      return {
        path: target,
        title: asString(input, 'title', {
          required: true,
        }).trim(),
        subtitle: asString(input, 'subtitle').trim(),
      };
    },
    requiresConfirmation: async (args) => {
      try {
        await fs.access(String(args.path));
        return '目标演示文稿已存在，重新创建会覆盖它。';
      } catch {
        return null;
      }
    },
    async execute(args, context) {
      await fs.mkdir(path.dirname(String(args.path)), { recursive: true });
      try {
        await context.desktop.createPresentation({
          path: String(args.path),
          title: String(args.title),
          subtitle: args.subtitle ? String(args.subtitle) : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          tool: 'office.create_presentation',
          speech:
            '无法创建 PowerPoint 文件，请确认电脑已安装 Microsoft PowerPoint。',
          error: {
            code: 'POWERPOINT_UNAVAILABLE',
            message,
          },
        };
      }
      return {
        ok: true,
        tool: 'office.create_presentation',
        speech: `已创建演示文稿 ${path.basename(String(args.path))}。`,
        data: {
          path: String(args.path),
          title: String(args.title),
        },
      };
    },
  },
];
