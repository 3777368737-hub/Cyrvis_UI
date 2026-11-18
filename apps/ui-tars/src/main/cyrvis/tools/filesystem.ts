/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition, ToolResult } from './types';

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_ENTRIES = 8_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_TREE_ENTRIES = 250;
const MAX_TREE_DEPTH = 3;
const TEXT_PREVIEW_CHARS = 240;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'out',
  '.turbo',
  '.next',
  '.cache',
]);

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

const asBoolean = (
  input: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean =>
  typeof input[key] === 'boolean' ? (input[key] as boolean) : fallback;

const asNumber = (
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum?: number,
): number => {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.max(1, Math.floor(value));
  return maximum === undefined ? integer : Math.min(integer, maximum);
};

const bytes = (value: number): string => {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const preview = (value: string, maximum = TEXT_PREVIEW_CHARS): string => {
  const compact = value.replace(/\r\n/g, '\n').trim();
  if (compact.length <= maximum) {
    return compact;
  }
  return `${compact.slice(0, maximum)}…`;
};

const failure = (
  tool: string,
  speech: string,
  code = 'TOOL_FAILED',
): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code, message: speech },
});

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const statKind = (value: Awaited<ReturnType<typeof fs.stat>>): string =>
  value.isDirectory()
    ? 'directory'
    : value.isFile()
      ? 'file'
      : value.isSymbolicLink()
        ? 'symlink'
        : 'other';

const fileMatchesQuery = (name: string, query: string): boolean => {
  if (!query.includes('*') && !query.includes('?')) {
    return name.toLowerCase().includes(query.toLowerCase());
  }
  const escaped = query.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i').test(name);
};

const walk = async (
  root: string,
  options: {
    maximumEntries: number;
    maximumDepth?: number;
    budget?: { visited: number };
    onEntry: (
      entryPath: string,
      stats: Awaited<ReturnType<typeof fs.stat>>,
      depth: number,
    ) => boolean | void | Promise<boolean | void>;
    depth?: number;
  },
): Promise<void> => {
  const budget = options.budget || { visited: 0 };
  const depth = options.depth ?? 0;
  if (options.maximumDepth !== undefined && depth > options.maximumDepth) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    if (budget.visited >= options.maximumEntries) {
      return;
    }
    const entryPath = path.join(root, entry.name);
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.lstat(entryPath);
    } catch {
      continue;
    }
    budget.visited += 1;
    if ((await options.onEntry(entryPath, stats, depth)) === false) {
      return;
    }
    if (
      stats.isDirectory() &&
      !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())
    ) {
      await walk(entryPath, {
        ...options,
        budget,
        depth: depth + 1,
      });
    }
  }
};

export const FILESYSTEM_TOOLS: ToolDefinition[] = [
  {
    name: 'fs.list_directory',
    domain: 'filesystem',
    description: 'List files and folders directly inside a directory.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 500 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      limit: asNumber(input, 'limit', 200, 500),
    }),
    async execute(args) {
      const limit = Number(args.limit);
      const entries = await fs.readdir(String(args.path), {
        withFileTypes: true,
      });
      entries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
      const visible = entries.slice(0, limit).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other',
      }));
      const names = visible
        .slice(0, 8)
        .map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`)
        .join('、');
      return success(
        'fs.list_directory',
        `目录里有 ${entries.length} 项${names ? `，包括 ${names}` : ''}。`,
        {
          path: String(args.path),
          total: entries.length,
          entries: visible,
        },
      );
    },
  },
  {
    name: 'fs.directory_tree',
    domain: 'filesystem',
    description: 'Show a bounded directory tree.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'number', minimum: 1, maximum: 5 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      depth: asNumber(input, 'depth', 2, MAX_TREE_DEPTH),
    }),
    async execute(args) {
      const lines: string[] = [];
      await walk(String(args.path), {
        maximumEntries: MAX_TREE_ENTRIES,
        maximumDepth: Number(args.depth),
        onEntry: (entryPath, stats, depth) => {
          lines.push(
            `${'  '.repeat(depth)}${path.basename(entryPath)}${stats.isDirectory() ? '/' : ''}`,
          );
        },
      });
      return success(
        'fs.directory_tree',
        `已生成目录树，共列出 ${lines.length} 项。`,
        { path: String(args.path), tree: lines },
      );
    },
  },
  {
    name: 'fs.get_info',
    domain: 'filesystem',
    description: 'Get metadata for a file or directory.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
    }),
    async execute(args) {
      const stats = await fs.stat(String(args.path));
      const kind = statKind(stats);
      return success(
        'fs.get_info',
        `${path.basename(String(args.path))} 是${kind === 'directory' ? '文件夹' : '文件'}，大小 ${bytes(stats.size)}。`,
        {
          path: String(args.path),
          kind,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        },
      );
    },
  },
  {
    name: 'fs.read_file',
    domain: 'filesystem',
    description: 'Read a UTF-8 text file with a bounded size.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'number', minimum: 1, maximum: MAX_READ_BYTES },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      maxBytes: asNumber(input, 'maxBytes', MAX_READ_BYTES, MAX_READ_BYTES),
    }),
    async execute(args) {
      const stats = await fs.stat(String(args.path));
      if (!stats.isFile()) {
        return failure('fs.read_file', '目标不是文件。');
      }
      const maximum = Number(args.maxBytes);
      const handle = await fs.open(String(args.path), 'r');
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(Math.min(stats.size, maximum));
        await handle.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle.close();
      }
      if (buffer.includes(0)) {
        return failure(
          'fs.read_file',
          '目标看起来是二进制文件，不能作为文本朗读。',
          'BINARY_FILE',
        );
      }
      const content = buffer.toString('utf8');
      return success(
        'fs.read_file',
        `读取完成，共 ${stats.size} 字节。内容开头是：${preview(content)}`,
        {
          path: String(args.path),
          size: stats.size,
          truncated: stats.size > buffer.length,
          content,
        },
      );
    },
  },
  {
    name: 'fs.create_file',
    domain: 'filesystem',
    description: 'Create a text file without overwriting an existing file.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    requiresConfirmation: async (args) =>
      args.overwrite && (await exists(String(args.path)))
        ? '文件已经存在，覆盖会丢失原内容。'
        : null,
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      content: asString(input, 'content'),
      overwrite: asBoolean(input, 'overwrite'),
    }),
    async execute(args) {
      await fs.mkdir(path.dirname(String(args.path)), { recursive: true });
      await fs.writeFile(
        String(args.path),
        String(args.content),
        args.overwrite ? 'utf8' : { encoding: 'utf8', flag: 'wx' },
      );
      return success(
        'fs.create_file',
        `已创建文件 ${path.basename(String(args.path))}。`,
        {
          path: String(args.path),
          bytes: Buffer.byteLength(String(args.content)),
        },
      );
    },
  },
  {
    name: 'fs.write_file',
    domain: 'filesystem',
    description: 'Write complete text content to a file.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    requiresConfirmation: async (args) =>
      (await exists(String(args.path)))
        ? '目标文件已存在，写入会替换原内容。'
        : null,
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      content: asString(input, 'content', { required: true }),
    }),
    async execute(args) {
      await fs.mkdir(path.dirname(String(args.path)), { recursive: true });
      await fs.writeFile(String(args.path), String(args.content), 'utf8');
      return success(
        'fs.write_file',
        `已写入文件 ${path.basename(String(args.path))}。`,
        {
          path: String(args.path),
          bytes: Buffer.byteLength(String(args.content)),
        },
      );
    },
  },
  {
    name: 'fs.append_file',
    domain: 'filesystem',
    description: 'Append text to a file.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      content: asString(input, 'content', { required: true }),
    }),
    async execute(args) {
      await fs.mkdir(path.dirname(String(args.path)), { recursive: true });
      await fs.appendFile(String(args.path), String(args.content), 'utf8');
      return success(
        'fs.append_file',
        `已追加内容到 ${path.basename(String(args.path))}。`,
        {
          path: String(args.path),
          bytes: Buffer.byteLength(String(args.content)),
        },
      );
    },
  },
  {
    name: 'fs.replace_text',
    domain: 'filesystem',
    description: 'Replace exact text in a UTF-8 file.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        all: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
      oldText: asString(input, 'oldText', { required: true }),
      newText: asString(input, 'newText', { required: true }),
      all: asBoolean(input, 'all'),
    }),
    async execute(args) {
      const content = await fs.readFile(String(args.path), 'utf8');
      const before = String(args.oldText);
      if (!content.includes(before)) {
        return failure(
          'fs.replace_text',
          '文件里没有找到要替换的原文。',
          'TEXT_NOT_FOUND',
        );
      }
      const next = args.all
        ? content.split(before).join(String(args.newText))
        : content.replace(before, String(args.newText));
      await fs.writeFile(String(args.path), next, 'utf8');
      return success(
        'fs.replace_text',
        `已修改 ${path.basename(String(args.path))}。`,
        { path: String(args.path) },
      );
    },
  },
  {
    name: 'fs.create_directory',
    domain: 'filesystem',
    description: 'Create a directory and any missing parents.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
    }),
    async execute(args) {
      await fs.mkdir(String(args.path), { recursive: true });
      return success(
        'fs.create_directory',
        `已创建文件夹 ${path.basename(String(args.path))}。`,
        { path: String(args.path) },
      );
    },
  },
  {
    name: 'fs.copy',
    domain: 'filesystem',
    description: 'Copy a file or directory.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.source), String(args.destination)],
    requiresConfirmation: async (args) =>
      (await exists(String(args.destination)))
        ? '目标路径已经存在，覆盖会改变现有内容。'
        : null,
    prepare: (input, context) => ({
      source: context.resolvePath(
        asString(input, 'source', { required: true }),
      ),
      destination: context.resolvePath(
        asString(input, 'destination', { required: true }),
      ),
      overwrite: asBoolean(input, 'overwrite'),
    }),
    async execute(args) {
      await fs.mkdir(path.dirname(String(args.destination)), {
        recursive: true,
      });
      await fs.cp(String(args.source), String(args.destination), {
        recursive: true,
        force: Boolean(args.overwrite),
        errorOnExist: !args.overwrite,
      });
      return success(
        'fs.copy',
        `已复制到 ${path.basename(String(args.destination))}。`,
        { source: String(args.source), destination: String(args.destination) },
      );
    },
  },
  {
    name: 'fs.move',
    domain: 'filesystem',
    description: 'Move a file or directory to another path.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.source), String(args.destination)],
    requiresConfirmation: async (args) =>
      (await exists(String(args.destination)))
        ? '目标路径已经存在，移动可能覆盖或合并内容。'
        : null,
    prepare: (input, context) => ({
      source: context.resolvePath(
        asString(input, 'source', { required: true }),
      ),
      destination: context.resolvePath(
        asString(input, 'destination', { required: true }),
      ),
    }),
    async execute(args) {
      await fs.mkdir(path.dirname(String(args.destination)), {
        recursive: true,
      });
      try {
        await fs.rename(String(args.source), String(args.destination));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'EXDEV'
        ) {
          throw error;
        }
        await fs.cp(String(args.source), String(args.destination), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        await fs.rm(String(args.source), { recursive: true });
      }
      return success(
        'fs.move',
        `已移动到 ${path.basename(String(args.destination))}。`,
        { source: String(args.source), destination: String(args.destination) },
      );
    },
  },
  {
    name: 'fs.rename',
    domain: 'filesystem',
    description: 'Rename a file or directory in place.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        newName: { type: 'string' },
      },
      required: ['path', 'newName'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path), String(args.destination)],
    requiresConfirmation: async (args) =>
      (await exists(String(args.destination)))
        ? '同名目标已经存在，不能直接重命名。'
        : null,
    prepare: (input, context) => {
      const source = context.resolvePath(
        asString(input, 'path', { required: true }),
      );
      const newName = asString(input, 'newName', { required: true });
      if (newName.includes('/') || newName.includes('\\')) {
        throw new Error('newName must not contain a path separator');
      }
      return {
        path: source,
        newName,
        destination: path.join(path.dirname(source), newName),
      };
    },
    async execute(args) {
      await fs.rename(String(args.path), String(args.destination));
      return success('fs.rename', `已重命名为 ${String(args.newName)}。`, {
        path: String(args.path),
        destination: String(args.destination),
      });
    },
  },
  {
    name: 'fs.delete_to_trash',
    domain: 'filesystem',
    description:
      'Move a file or directory to the recycle bin. This is always confirmed.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    requiresConfirmation: () => '这个操作会把目标移到回收站。',
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
    }),
    async execute(args, context) {
      const target = String(args.path);
      const stats = await fs.stat(target);
      const script = stats.isDirectory()
        ? `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CYRV_TOOL_PATH,'OnlyErrorDialogs','SendToRecycleBin')`
        : `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CYRV_TOOL_PATH,'OnlyErrorDialogs','SendToRecycleBin')`;
      if (process.platform === 'win32') {
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
              env: { ...process.env, CYRV_TOOL_PATH: target },
              timeout: 15_000,
              windowsHide: true,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
      } else {
        const trashDirectory = path.join(
          context.homeDirectory,
          '.cyrvis-trash',
        );
        await fs.mkdir(trashDirectory, { recursive: true });
        const destination = path.join(
          trashDirectory,
          `${Date.now()}-${path.basename(target)}`,
        );
        await fs.rename(target, destination);
      }
      return success(
        'fs.delete_to_trash',
        `已将 ${path.basename(target)} 移到回收站。`,
        { path: target },
      );
    },
  },
  {
    name: 'fs.search',
    domain: 'filesystem',
    description: 'Search file names or text content under a directory.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        scope: { type: 'string', enum: ['name', 'content'] },
        limit: { type: 'number', minimum: 1, maximum: 500 },
      },
      required: ['path', 'query'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => {
      const scope = asString(input, 'scope', { fallback: 'name' });
      if (scope !== 'name' && scope !== 'content') {
        throw new Error('scope must be name or content');
      }
      return {
        path: context.resolvePath(asString(input, 'path', { required: true })),
        query: asString(input, 'query', { required: true }),
        scope,
        limit: asNumber(input, 'limit', MAX_SEARCH_RESULTS, 500),
      };
    },
    async execute(args) {
      const matches: Array<{ path: string; line?: number; preview?: string }> =
        [];
      const query = String(args.query);
      const contentScope = args.scope === 'content';
      await walk(String(args.path), {
        maximumEntries: MAX_SEARCH_ENTRIES,
        maximumDepth: 12,
        onEntry: async (entryPath, stats) => {
          if (matches.length >= Number(args.limit)) {
            return false;
          }
          if (!contentScope) {
            if (fileMatchesQuery(path.basename(entryPath), query)) {
              matches.push({ path: entryPath });
            }
            return;
          }
          if (!stats.isFile() || stats.size > 2 * 1024 * 1024) {
            return;
          }
          try {
            const content = await fs.readFile(entryPath, 'utf8');
            const lines = content.split(/\r?\n/);
            const index = lines.findIndex((line) =>
              line.toLowerCase().includes(query.toLowerCase()),
            );
            if (index >= 0) {
              matches.push({
                path: entryPath,
                line: index + 1,
                preview: preview(lines[index], 120),
              });
            }
          } catch {
            // Ignore binary and unreadable files during bounded search.
          }
          return undefined;
        },
      });
      return success(
        'fs.search',
        matches.length
          ? `找到 ${matches.length} 个匹配项。`
          : '没有找到匹配项。',
        { path: String(args.path), query, scope: args.scope, matches },
      );
    },
  },
  {
    name: 'fs.open_random',
    domain: 'desktop',
    description:
      'Open one random file from a directory, optionally filtered by extension.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        extension: { type: 'string' },
      },
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => {
      const requestedPath =
        asString(input, 'path').trim() ||
        asString(input, 'folder').trim() ||
        '桌面';
      const rawExtension = asString(input, 'extension').trim();
      const extension = rawExtension
        .replace(/^\./, '')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLowerCase();
      return {
        path: context.resolvePath(requestedPath),
        extension: extension || 'txt',
      };
    },
    async execute(args, context) {
      const directory = String(args.path);
      const extension = String(args.extension).toLowerCase();
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const candidates = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            path.extname(entry.name).slice(1).toLowerCase() === extension,
        )
        .map((entry) => path.join(directory, entry.name))
        .sort((left, right) => left.localeCompare(right));
      if (!candidates.length) {
        return failure(
          'fs.open_random',
          `目录里没有找到 .${extension} 文件。`,
          'NO_MATCHING_FILE',
        );
      }
      const selected =
        candidates[Math.floor(Math.random() * candidates.length)];
      await context.desktop.openPath(selected);
      return success(
        'fs.open_random',
        `随机打开 ${path.basename(selected)}。`,
        {
          path: selected,
          extension,
          candidates: candidates.length,
        },
      );
    },
  },
  {
    name: 'fs.open',
    domain: 'desktop',
    description:
      'Open a file or directory with the operating system default app.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(asString(input, 'path', { required: true })),
    }),
    async execute(args, context) {
      await fs.access(String(args.path));
      await context.desktop.openPath(String(args.path));
      return success(
        'fs.open',
        `已打开 ${path.basename(String(args.path))}。`,
        { path: String(args.path) },
      );
    },
  },
];
