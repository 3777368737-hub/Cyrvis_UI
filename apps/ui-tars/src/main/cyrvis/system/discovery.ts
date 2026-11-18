/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  BatteryState,
  DiskState,
  InstalledApplication,
  ServiceState,
  SteamGame,
} from './types';

const runPowerShell = (script: string, timeout = 30_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              (stderr || stdout || error.message).trim() || error.message,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const parseJson = <T>(value: string, fallback: T): T => {
  const trimmed = value.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed === 'null') {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
};

const normalizeName = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(?:64-bit|x64|x86|version|版本)\b/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

const slug = (source: string, value: string): string =>
  `${source}-${normalizeName(value)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, 80)}`;

const expandWindowsEnvironment = (value: string): string =>
  value.replace(/%([^%]+)%/g, (match, name: string) => {
    return process.env[name] ?? match;
  });

const cleanExecutable = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const cleaned = expandWindowsEnvironment(
    value.trim().replace(/^"|"$/g, '').split(',')[0].trim(),
  );
  return cleaned || undefined;
};

interface StartAppRecord {
  Name?: string;
  AppID?: string;
}

interface RegistryAppRecord {
  name?: string;
  version?: string;
  publisher?: string;
  installLocation?: string;
  displayIcon?: string;
}

const discoverWindowsApplications = async (): Promise<
  InstalledApplication[]
> => {
  const [startAppsRaw, registryRaw] = await Promise.all([
    runPowerShell(
      'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
    ).catch(() => '[]'),
    runPowerShell(`
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = foreach ($itemPath in $paths) {
  Get-ItemProperty $itemPath -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName } |
    ForEach-Object {
      [pscustomobject]@{
        name = $_.DisplayName
        version = $_.DisplayVersion
        publisher = $_.Publisher
        installLocation = $_.InstallLocation
        displayIcon = $_.DisplayIcon
      }
    }
}
$items | ConvertTo-Json -Compress
`).catch(() => '[]'),
  ]);
  const startApps = parseJson<StartAppRecord[] | StartAppRecord>(
    startAppsRaw,
    [],
  );
  const registry = parseJson<RegistryAppRecord[] | RegistryAppRecord>(
    registryRaw,
    [],
  );
  const startList = Array.isArray(startApps) ? startApps : [startApps];
  const registryList = Array.isArray(registry) ? registry : [registry];
  const apps: InstalledApplication[] = [];

  for (const app of startList) {
    const name = app?.Name?.trim();
    const appId = app?.AppID?.trim();
    if (!name || !appId) {
      continue;
    }
    apps.push({
      id: slug('start', name),
      name,
      source: 'start-app',
      launchTarget: `shell:AppsFolder\\${appId}`,
    });
  }

  for (const app of registryList) {
    const name = app?.name?.trim();
    if (!name) {
      continue;
    }
    const executable = cleanExecutable(app.displayIcon);
    apps.push({
      id: slug('registry', name),
      name,
      source: 'registry',
      version: app.version?.trim() || undefined,
      publisher: app.publisher?.trim() || undefined,
      installLocation: app.installLocation?.trim() || undefined,
      executable,
      launchTarget: executable || app.installLocation?.trim() || undefined,
    });
  }

  return dedupeApplications(apps);
};

const discoverApplicationsFolder = async (): Promise<
  InstalledApplication[]
> => {
  if (process.platform !== 'darwin') {
    return [];
  }
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  const result: InstalledApplication[] = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith('.app')) {
          continue;
        }
        const target = path.join(root, entry.name);
        const name = entry.name.slice(0, -4);
        result.push({
          id: slug('app', name),
          name,
          source: 'applications-folder',
          launchTarget: target,
        });
      }
    } catch {
      // Directory can be inaccessible or absent.
    }
  }
  return dedupeApplications(result);
};

interface DesktopEntry {
  name?: string;
  exec?: string;
}

const parseDesktopEntry = (value: string): DesktopEntry => {
  const result: DesktopEntry = {};
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('Name=') && !result.name) {
      result.name = line.slice(5).trim();
    } else if (line.startsWith('Exec=') && !result.exec) {
      result.exec = line
        .slice(5)
        .replace(/%[fFuUdDnNickvm]/g, '')
        .trim();
    }
  }
  return result;
};

const discoverDesktopEntries = async (): Promise<InstalledApplication[]> => {
  if (process.platform !== 'linux') {
    return [];
  }
  const roots = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local/share/applications'),
  ];
  const apps: InstalledApplication[] = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.desktop')) {
          continue;
        }
        try {
          const content = await fs.readFile(
            path.join(root, entry.name),
            'utf8',
          );
          const parsed = parseDesktopEntry(content);
          if (!parsed.name || !parsed.exec) {
            continue;
          }
          apps.push({
            id: slug('desktop', parsed.name),
            name: parsed.name,
            source: 'desktop-entry',
            executable: parsed.exec,
            launchTarget: parsed.exec,
          });
        } catch {
          // Ignore unreadable desktop files.
        }
      }
    } catch {
      // Directory can be absent.
    }
  }
  return dedupeApplications(apps);
};

const dedupeApplications = (
  applications: InstalledApplication[],
): InstalledApplication[] => {
  const byName = new Map<string, InstalledApplication>();
  const sourcePriority: Record<InstalledApplication['source'], number> = {
    'start-app': 5,
    'applications-folder': 4,
    'desktop-entry': 4,
    registry: 3,
    steam: 2,
  };
  for (const app of applications) {
    const key = normalizeName(app.name);
    if (!key) {
      continue;
    }
    const existing = byName.get(key);
    if (
      !existing ||
      sourcePriority[app.source] > sourcePriority[existing.source]
    ) {
      byName.set(key, {
        ...existing,
        ...app,
        executable: app.executable || existing?.executable,
        launchTarget: app.launchTarget || existing?.launchTarget,
        installLocation: app.installLocation || existing?.installLocation,
      });
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

export const discoverInstalledApplications = async (): Promise<
  InstalledApplication[]
> => {
  if (process.platform === 'win32') {
    return discoverWindowsApplications();
  }
  if (process.platform === 'darwin') {
    return discoverApplicationsFolder();
  }
  return discoverDesktopEntries();
};

const decodeVdfPath = (value: string): string => value.replace(/\\\\/g, '\\');

const parseVdfValue = (content: string, key: string): string | undefined => {
  const match = content.match(
    new RegExp(`"${key}"\\s+"((?:\\\\.|[^"])*)"`, 'i'),
  );
  return match?.[1] ? decodeVdfPath(match[1]) : undefined;
};

const findSteamRoot = async (): Promise<string | null> => {
  if (process.platform === 'win32') {
    const output = await runPowerShell(`
$paths = @(
  'HKCU:\\Software\\Valve\\Steam',
  'HKLM:\\Software\\WOW6432Node\\Valve\\Steam',
  'HKLM:\\Software\\Valve\\Steam'
)
foreach ($itemPath in $paths) {
  $item = Get-ItemProperty $itemPath -ErrorAction SilentlyContinue
  if ($item.SteamPath) { Write-Output $item.SteamPath; break }
  if ($item.InstallPath) { Write-Output $item.InstallPath; break }
}
`).catch(() => '');
    return output.trim() || null;
  }
  if (process.platform === 'darwin') {
    const target = path.join(os.homedir(), 'Library/Application Support/Steam');
    return fs
      .access(target)
      .then(() => target)
      .catch(() => null);
  }
  const target = path.join(os.homedir(), '.steam/steam');
  return fs
    .access(target)
    .then(() => target)
    .catch(() => null);
};

export const discoverSteamGames = async (): Promise<{
  root: string | null;
  games: SteamGame[];
}> => {
  const steamRoot = await findSteamRoot();
  if (!steamRoot) {
    return { root: null, games: [] };
  }
  const libraries = new Set<string>([path.join(steamRoot, 'steamapps')]);
  try {
    const content = await fs.readFile(
      path.join(steamRoot, 'steamapps/libraryfolders.vdf'),
      'utf8',
    );
    for (const match of content.matchAll(/"path"\s+"((?:\\.|[^"])*)"/gi)) {
      const libraryPath = decodeVdfPath(match[1]);
      libraries.add(path.join(libraryPath, 'steamapps'));
    }
  } catch {
    // Older Steam installations can have only the root library.
  }

  const games: SteamGame[] = [];
  for (const libraryPath of libraries) {
    try {
      const entries = await fs.readdir(libraryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^appmanifest_\d+\.acf$/i.test(entry.name)) {
          continue;
        }
        try {
          const content = await fs.readFile(
            path.join(libraryPath, entry.name),
            'utf8',
          );
          const appId = parseVdfValue(content, 'appid');
          const name = parseVdfValue(content, 'name');
          const installDirectory = parseVdfValue(content, 'installdir');
          const size = parseVdfValue(content, 'SizeOnDisk');
          if (!appId || !name || !installDirectory) {
            continue;
          }
          games.push({
            appId,
            name,
            installDirectory,
            libraryPath,
            sizeBytes: size ? Number(size) : undefined,
          });
        } catch {
          // Skip malformed manifests and continue scanning.
        }
      }
    } catch {
      // Steam libraries can be disconnected drives.
    }
  }
  const uniqueGames = new Map<string, SteamGame>();
  for (const game of games) {
    if (!uniqueGames.has(game.appId)) {
      uniqueGames.set(game.appId, game);
    }
  }
  const dedupedGames = [...uniqueGames.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return { root: steamRoot, games: dedupedGames };
};

const discoverWindowsDisks = async (): Promise<DiskState[]> => {
  const output = await runPowerShell(
    'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
  ).catch(() => '[]');
  const records = parseJson<
    Array<{ DeviceID?: string; Size?: number; FreeSpace?: number }>
  >(output, []);
  return records
    .filter((record) => record.DeviceID && record.Size)
    .map((record) => ({
      name: record.DeviceID || '',
      mountPoint: `${record.DeviceID}\\`,
      totalBytes: Number(record.Size || 0),
      freeBytes: Number(record.FreeSpace || 0),
    }));
};

const discoverGenericDisks = async (): Promise<DiskState[]> => {
  const targets =
    process.platform === 'win32'
      ? []
      : process.platform === 'darwin'
        ? ['/']
        : ['/', os.homedir()];
  const disks: DiskState[] = [];
  for (const target of targets) {
    try {
      const stats = await fs.statfs(target);
      disks.push({
        name: target === '/' ? 'root' : target,
        mountPoint: target,
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      });
    } catch {
      // Ignore unsupported filesystems.
    }
  }
  return disks;
};

export const discoverDisks = async (): Promise<DiskState[]> =>
  process.platform === 'win32'
    ? discoverWindowsDisks()
    : discoverGenericDisks();

export const discoverBattery = async (): Promise<BatteryState | null> => {
  if (process.platform !== 'win32') {
    return null;
  }
  const output = await runPowerShell(
    'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime | ConvertTo-Json -Compress',
  ).catch(() => '');
  const record = parseJson<{
    EstimatedChargeRemaining?: number;
    BatteryStatus?: number;
    EstimatedRunTime?: number;
  } | null>(output, null);
  if (!record || typeof record.EstimatedChargeRemaining !== 'number') {
    return null;
  }
  return {
    percent: record.EstimatedChargeRemaining,
    charging: record.BatteryStatus === 2 || record.BatteryStatus === 6,
    estimatedMinutes:
      typeof record.EstimatedRunTime === 'number' &&
      record.EstimatedRunTime < 71582788
        ? record.EstimatedRunTime
        : undefined,
  };
};

export const discoverServices = async (): Promise<ServiceState[]> => {
  if (process.platform !== 'win32') {
    return [];
  }
  const output = await runPowerShell(
    'Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress',
  ).catch(() => '[]');
  const records = parseJson<
    Array<{
      Name?: string;
      DisplayName?: string;
      Status?: string | number;
      StartType?: string | number;
    }>
  >(output, []);
  return records
    .filter((record) => record.Name)
    .map((record) => ({
      name: record.Name || '',
      displayName: record.DisplayName || record.Name || '',
      status: String(record.Status ?? ''),
      startType: String(record.StartType ?? ''),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};
