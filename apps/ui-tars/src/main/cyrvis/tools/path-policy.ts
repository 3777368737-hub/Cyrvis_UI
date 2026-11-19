/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BLOCKED_PATTERNS = [
  /[\\/]\.ssh(?:[\\/]|$)/i,
  /[\\/]\.aws(?:[\\/]|$)/i,
  /[\\/]\.azure(?:[\\/]|$)/i,
  /[\\/]\.gnupg(?:[\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Credentials(?:[\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Google[\\/]Chrome[\\/]User Data(?:[\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Microsoft[\\/]Edge[\\/]User Data(?:[\\/]|$)/i,
];

const SENSITIVE_FILE_PATTERNS = [
  /(?:^|[\\/])\.env(?:\.|$)/i,
  /(?:^|[\\/])id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/i,
  /(?:^|[\\/])credentials(?:\.json)?$/i,
  /(?:^|[\\/]).+\.(?:pem|pfx|p12)$/i,
];

const splitRoots = (value: string | undefined): string[] =>
  (value || '')
    .split(/[;\r\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const findProjectRoot = (start: string): string | null => {
  let current = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
      fs.existsSync(path.join(current, 'pnpm-lock.yaml'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

export interface PathPolicyInspection {
  resolvedPaths: string[];
  requiresConfirmation: boolean;
  reason: string | null;
}

export interface PathPolicyOptions {
  allowOutsideRoots?: boolean;
}

export class PathPolicy {
  private readonly allowedRoots: string[];
  private readonly homeDirectory: string;

  constructor(
    cwd = process.cwd(),
    homeDirectory = os.homedir(),
    configuredRoots = process.env.CYRVIS_FAST_TOOL_ROOTS ||
      process.env.CYRV_FAST_TOOL_ROOTS,
  ) {
    this.homeDirectory = path.resolve(homeDirectory);
    const projectRoot = findProjectRoot(cwd);
    this.allowedRoots = Array.from(
      new Set(
        [
          this.homeDirectory,
          cwd,
          projectRoot,
          os.tmpdir(),
          ...splitRoots(configuredRoots),
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => path.resolve(value)),
      ),
    );
  }

  resolve(input: string, base = this.homeDirectory): string {
    const repaired = this.repairWindowsPath(input.trim());
    const expanded = this.expandVariables(repaired);
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(base, expanded);
    return this.canonicalize(this.relocateCurrentUserPath(absolute));
  }

  inspect(
    paths: string[],
    allowedRoots: string[] = this.allowedRoots,
    options: PathPolicyOptions = {},
  ) {
    const resolvedPaths = paths.map((entry) => this.resolve(entry));
    const blocked = resolvedPaths.find((entry) =>
      DEFAULT_BLOCKED_PATTERNS.some((pattern) => pattern.test(entry)),
    );
    if (blocked) {
      return {
        resolvedPaths,
        requiresConfirmation: true,
        reason: `路径涉及受保护目录：${blocked}`,
      } satisfies PathPolicyInspection;
    }

    const sensitive = resolvedPaths.find((entry) =>
      SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(entry)),
    );
    if (sensitive) {
      return {
        resolvedPaths,
        requiresConfirmation: true,
        reason: `路径可能是敏感文件：${sensitive}`,
      } satisfies PathPolicyInspection;
    }

    if (!options.allowOutsideRoots) {
      const outside = resolvedPaths.find(
        (entry) =>
          !allowedRoots.some((root) => {
            const relative = path.relative(root, entry);
            return (
              relative === '' ||
              (!relative.startsWith('..') && !path.isAbsolute(relative))
            );
          }),
      );
      if (outside) {
        return {
          resolvedPaths,
          requiresConfirmation: true,
          reason: `路径在工作区之外：${outside}`,
        } satisfies PathPolicyInspection;
      }
    }

    return {
      resolvedPaths,
      requiresConfirmation: false,
      reason: null,
    } satisfies PathPolicyInspection;
  }

  private expandVariables(input: string): string {
    let output = input;
    const folderAliases: Record<string, string> = {
      桌面: 'Desktop',
      desktop: 'Desktop',
      下载: 'Downloads',
      downloads: 'Downloads',
      文档: 'Documents',
      documents: 'Documents',
      图片: 'Pictures',
      pictures: 'Pictures',
      音乐: 'Music',
      music: 'Music',
      视频: 'Videos',
      videos: 'Videos',
    };
    const normalizedFolder = output.split(/[\\/]/, 1)[0]?.trim().toLowerCase();
    const mappedFolder = normalizedFolder
      ? folderAliases[normalizedFolder]
      : undefined;
    if (mappedFolder) {
      const remainder = output.replace(
        new RegExp(`^${normalizedFolder}[\\\\/]?`, 'i'),
        '',
      );
      output = path.join(this.homeDirectory, mappedFolder, remainder);
    } else if (output === '~') {
      output = this.homeDirectory;
    } else if (output.startsWith('~/') || output.startsWith('~\\')) {
      output = path.join(this.homeDirectory, output.slice(2));
    }
    output = output.replace(
      /%([^%]+)%/g,
      (match, name: string) => this.environmentValue(name) ?? match,
    );
    output = output.replace(
      /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced: string | undefined, plain: string | undefined) => {
        const name = braced || plain || '';
        return this.environmentValue(name) ?? match;
      },
    );
    return output;
  }

  private environmentValue(name: string): string | undefined {
    if (process.env[name]) {
      return process.env[name];
    }
    const normalized = name.toUpperCase();
    if (
      normalized === 'USERPROFILE' ||
      normalized === 'HOME' ||
      normalized === 'HOMEPATH'
    ) {
      return this.homeDirectory;
    }
    if (normalized === 'USERNAME' || normalized === 'USER') {
      return path.basename(this.homeDirectory);
    }
    return undefined;
  }

  /**
   * Voice models occasionally drop Windows separators or infer a username
   * from the project path. Repair only against directories that actually
   * exist, so legitimate paths and filenames containing spaces stay intact.
   */
  private repairWindowsPath(input: string): string {
    if (process.platform !== 'win32' || !input) {
      return input;
    }
    let value = input.normalize('NFKC').trim();
    value = value
      .replace(/^([A-Za-z]):[ \t]+/, '$1:\\')
      .replace(/^([A-Za-z]):(?=[^\\/])/, '$1:\\');
    if (!/^[A-Za-z]:\\/.test(value) || fs.existsSync(value)) {
      return value;
    }

    const drive = value.slice(0, 2);
    let cursor = `${drive}\\`;
    const pending = value
      .slice(3)
      .split(/[\\/]+/)
      .filter(Boolean);
    while (pending.length) {
      const segment = pending.shift()!;
      const exact = path.join(cursor, segment);
      if (fs.existsSync(exact)) {
        cursor = exact;
        continue;
      }

      const words = segment.split(/\s+/).filter(Boolean);
      let matched = false;
      for (let count = words.length; count >= 1; count -= 1) {
        const candidateName = words.slice(0, count).join(' ');
        const candidate = path.join(cursor, candidateName);
        if (!fs.existsSync(candidate)) {
          continue;
        }
        cursor = candidate;
        const remainder = words.slice(count).join(' ');
        if (remainder) {
          pending.unshift(remainder);
        }
        matched = true;
        break;
      }
      if (
        !matched &&
        pending.length === 0 &&
        words.length > 1 &&
        path.basename(cursor).toLowerCase() === 'users'
      ) {
        cursor = path.join(cursor, words[0]);
        pending.unshift(words.slice(1).join(' '));
        continue;
      }
      if (!matched) {
        return path.join(cursor, [segment, ...pending].join('\\'));
      }
    }
    return path.normalize(cursor);
  }

  private relocateCurrentUserPath(input: string): string {
    if (process.platform !== 'win32' || !path.isAbsolute(input)) {
      return input;
    }
    const homeRoot = path.parse(this.homeDirectory).root;
    const inputRoot = path.parse(input).root;
    if (homeRoot.toLowerCase() !== inputRoot.toLowerCase()) {
      return input;
    }
    const relative = path.relative(inputRoot, input);
    const segments = relative.split(path.sep).filter(Boolean);
    if (
      segments.length < 2 ||
      segments[0]?.toLowerCase() !== 'users' ||
      segments[1]?.toLowerCase() ===
        path.basename(this.homeDirectory).toLowerCase()
    ) {
      return input;
    }

    const guessedUserRoot = path.join(inputRoot, segments[0], segments[1]);
    if (fs.existsSync(guessedUserRoot)) {
      return input;
    }
    const tail = segments.slice(2);
    const candidate = path.join(this.homeDirectory, ...tail);
    const knownFolder =
      tail.length > 0 &&
      ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']
        .map((folder) => path.join(this.homeDirectory, folder))
        .some(
          (folder) =>
            path.basename(folder).toLowerCase() === tail[0]?.toLowerCase() &&
            fs.existsSync(folder),
        );
    return tail.length === 0 || knownFolder || fs.existsSync(candidate)
      ? candidate
      : input;
  }

  private canonicalize(input: string): string {
    let cursor = input;
    const tail: string[] = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return input;
      }
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
    try {
      const real = fs.realpathSync.native(cursor);
      return path.normalize(path.join(real, ...tail));
    } catch {
      return input;
    }
  }
}
