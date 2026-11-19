/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SystemStateSnapshot } from '../system/types';
import type { CapabilityRequirements, ToolPermission } from './types';

export interface RequirementEvaluation {
  available: boolean;
  reason: string | null;
}

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const executableCache = new Map<string, boolean>();

const checkExecutableExists = (command: string): boolean => {
  if (
    path.isAbsolute(command) ||
    command.includes('/') ||
    command.includes('\\')
  ) {
    return fs.existsSync(command);
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      if (fs.existsSync(path.join(directory, `${command}${extension}`))) {
        return true;
      }
    }
  }
  return false;
};

const executableExists = (command: string): boolean => {
  const cached = executableCache.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const exists = checkExecutableExists(command);
  executableCache.set(command, exists);
  return exists;
};

export const mergeRequirements = (
  ...requirements: Array<CapabilityRequirements | undefined>
): CapabilityRequirements => {
  const merged: CapabilityRequirements = {};
  for (const requirement of requirements) {
    if (!requirement) {
      continue;
    }
    if (requirement.platforms?.length) {
      merged.platforms = [
        ...new Set([...(merged.platforms || []), ...requirement.platforms]),
      ];
    }
    if (requirement.applications?.length) {
      merged.applications = [
        ...new Set([
          ...(merged.applications || []),
          ...requirement.applications,
        ]),
      ];
    }
    if (requirement.services?.length) {
      merged.services = [
        ...new Set([...(merged.services || []), ...requirement.services]),
      ];
    }
    if (requirement.environment?.length) {
      merged.environment = [
        ...new Set([...(merged.environment || []), ...requirement.environment]),
      ];
    }
    if (requirement.executables?.length) {
      merged.executables = [
        ...new Set([...(merged.executables || []), ...requirement.executables]),
      ];
    }
    if (requirement.permissions?.length) {
      merged.permissions = [
        ...new Set([...(merged.permissions || []), ...requirement.permissions]),
      ];
    }
    if (requirement.steamGamesMin !== undefined) {
      merged.steamGamesMin = Math.max(
        merged.steamGamesMin || 0,
        requirement.steamGamesMin,
      );
    }
  }
  return merged;
};

export const evaluateRequirements = (
  requirements: CapabilityRequirements,
  snapshot: SystemStateSnapshot | null,
  deniedPermissions: ToolPermission[] = [],
): RequirementEvaluation => {
  if (
    requirements.platforms?.length &&
    !requirements.platforms.includes(process.platform)
  ) {
    return {
      available: false,
      reason: `仅支持平台：${requirements.platforms.join(', ')}。`,
    };
  }
  if (requirements.environment?.length) {
    const missing = requirements.environment.find((name) => !process.env[name]);
    if (missing) {
      return {
        available: false,
        reason: `缺少环境变量 ${missing}。`,
      };
    }
  }
  if (requirements.permissions?.length) {
    const denied = requirements.permissions.find((permission) =>
      deniedPermissions.includes(permission),
    );
    if (denied) {
      return {
        available: false,
        reason: `权限已被策略禁用：${denied}。`,
      };
    }
  }
  if (requirements.executables?.length) {
    const missing = requirements.executables.find(
      (command) => !executableExists(command),
    );
    if (missing) {
      return {
        available: false,
        reason: `缺少可执行文件：${missing}。`,
      };
    }
  }
  const needsSnapshot =
    Boolean(requirements.applications?.length) ||
    Boolean(requirements.services?.length) ||
    requirements.steamGamesMin !== undefined;
  if (needsSnapshot && !snapshot?.capturedAt) {
    return {
      available: false,
      reason: '系统初始扫描尚未完成。',
    };
  }
  if (!snapshot) {
    return { available: true, reason: null };
  }
  if (requirements.applications?.length) {
    const installed = snapshot.installedApplications.map((application) =>
      normalize(application.name),
    );
    const missing = requirements.applications.find(
      (name) => !installed.some((entry) => entry.includes(normalize(name))),
    );
    if (missing) {
      return {
        available: false,
        reason: `未发现所需应用：${missing}。`,
      };
    }
  }
  if (requirements.services?.length) {
    const services = snapshot.services.map((service) =>
      normalize(`${service.name} ${service.displayName}`),
    );
    const missing = requirements.services.find(
      (name) => !services.some((entry) => entry.includes(normalize(name))),
    );
    if (missing) {
      return {
        available: false,
        reason: `未发现所需服务：${missing}。`,
      };
    }
  }
  if (
    requirements.steamGamesMin !== undefined &&
    snapshot.steamGames.length < requirements.steamGamesMin
  ) {
    return {
      available: false,
      reason: `至少需要 ${requirements.steamGamesMin} 个 Steam 游戏。`,
    };
  }
  return { available: true, reason: null };
};
