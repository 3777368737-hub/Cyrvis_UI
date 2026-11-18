import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, shell } from 'electron';

import { logger } from '@main/logger';

import { buildSiteSearchUrl, resolveSite } from './site-registry';

export type SearchEngine = 'bing' | 'baidu' | 'google';
export type AllowedApp = 'vscode' | 'chrome' | 'explorer' | 'notepad';

const execFileAsync = promisify(execFile);

const SEARCH_ENDPOINTS: Record<SearchEngine, string> = {
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  google: 'https://www.google.com/search?q=',
};

const assertHttpUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  return url;
};

export const buildSearchUrl = (
  query: string,
  engine: SearchEngine = 'bing',
  site?: string,
): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('search query is empty');
  }
  const normalizedSite = site?.trim().replace(/^https?:\/\//i, '');
  if (normalizedSite && !/^[A-Za-z0-9.-]+$/.test(normalizedSite)) {
    throw new Error(`invalid site filter: ${site}`);
  }
  const fullQuery = normalizedSite
    ? `${trimmed} site:${normalizedSite}`
    : trimmed;
  return `${SEARCH_ENDPOINTS[engine]}${encodeURIComponent(fullQuery)}`;
};

/**
 * Windows uses Bing; macOS uses Safari's default search engine. The caller can
 * still override the engine explicitly.
 */
export const defaultSearchEngine = (): SearchEngine =>
  process.platform === 'darwin' ? 'google' : 'bing';

export const openUrl = async (value: string): Promise<string> => {
  const url = assertHttpUrl(value.trim());
  logger.info('[cyrvis desktop] opening url', { url: url.toString() });
  await shell.openExternal(url.toString());
  if (process.platform === 'win32') {
    void focusBrowserWithRetry();
  }
  return url.toString();
};

export interface OpenSiteResult {
  site: string;
  label: string;
  url: string;
}

export const openSite = async (
  value: string,
  query?: string,
): Promise<OpenSiteResult> => {
  const site = resolveSite(value);
  if (!site) {
    throw new Error(`unknown site: ${value}`);
  }
  const trimmedQuery = query?.trim() || '';
  const url = trimmedQuery ? buildSiteSearchUrl(site, trimmedQuery) : site.url;
  await openUrl(url);
  return { site: site.id, label: site.label, url };
};

const BROWSER_FOCUS_SCRIPT_CANDIDATES = () => [
  path.resolve(app.getAppPath(), '../../scripts/cyrvis/focus-browser.ps1'),
  path.resolve(process.cwd(), 'scripts/cyrvis/focus-browser.ps1'),
  path.resolve(process.cwd(), '../../scripts/cyrvis/focus-browser.ps1'),
];

const findBrowserFocusScript = (): string | null =>
  BROWSER_FOCUS_SCRIPT_CANDIDATES().find((candidate) =>
    fs.existsSync(candidate),
  ) ?? null;

/**
 * Windows opens the URL in an existing Edge/Chrome window without bringing it
 * to the foreground, especially when the browser is minimized. Restore and
 * activate it explicitly so a spoken search is visible.
 */
const focusBrowserWindow = async (): Promise<boolean> => {
  if (process.platform !== 'win32') {
    return false;
  }
  const script = findBrowserFocusScript();
  if (!script) {
    logger.warn('[cyrvis desktop] focus-browser.ps1 not found');
    return false;
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 5000, windowsHide: true },
    );
    const result = JSON.parse(stdout.trim()) as { ok?: boolean };
    logger.info('[cyrvis desktop] browser focus result', {
      ok: result.ok === true,
    });
    return result.ok === true;
  } catch (error) {
    logger.warn('[cyrvis desktop] browser focus failed', error);
    return false;
  }
};

const focusBrowserWithRetry = async (): Promise<void> => {
  for (const delayMs of [250, 700, 1500, 3000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await focusBrowserWindow()) {
      return;
    }
  }
};

/**
 * Search opens in the platform's native browser: Bing on Windows, Safari on
 * macOS. If Safari is unavailable, fall back to the default browser.
 */
export const openSearch = async (value: string): Promise<string> => {
  const url = assertHttpUrl(value.trim()).toString();
  logger.info('[cyrvis desktop] opening search', {
    url,
    platform: process.platform,
  });

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('open', ['-a', 'Safari', url], { timeout: 3000 });
      return url;
    } catch (error) {
      logger.warn(
        '[cyrvis desktop] Safari launch failed; using default browser',
        error,
      );
    }
  }

  await shell.openExternal(url);
  if (process.platform === 'win32') {
    void focusBrowserWithRetry();
  }
  return url;
};

const firstExisting = (
  candidates: Array<string | undefined>,
): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const findVscode = () =>
  firstExisting([
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          'Programs',
          'Microsoft VS Code',
          'Code.exe',
        )
      : undefined,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
      : undefined,
    process.env['ProgramFiles(x86)']
      ? path.join(
          process.env['ProgramFiles(x86)'],
          'Microsoft VS Code',
          'Code.exe',
        )
      : undefined,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ]);

const findChrome = () =>
  firstExisting([
    process.env.ProgramFiles
      ? path.join(
          process.env.ProgramFiles,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
    process.env['ProgramFiles(x86)']
      ? path.join(
          process.env['ProgramFiles(x86)'],
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
  ]);

const spawnDetached = (executable: string, args: string[]) => {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
};

export const openApp = async (
  app: AllowedApp,
  target?: string,
): Promise<{ app: AllowedApp; target: string | null; pid?: number }> => {
  const trimmedTarget = target?.trim() || '';
  switch (app) {
    case 'vscode': {
      const executable = findVscode();
      if (!executable) {
        throw new Error('VS Code executable was not found');
      }
      const pid = spawnDetached(
        executable,
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    case 'chrome': {
      const executable = findChrome();
      if (executable) {
        const pid = spawnDetached(executable, [
          '--new-tab',
          trimmedTarget || 'about:blank',
        ]);
        return { app, target: trimmedTarget || null, pid };
      }
      const url = trimmedTarget
        ? assertHttpUrl(trimmedTarget).toString()
        : 'https://www.bing.com';
      await shell.openExternal(url);
      return { app, target: url };
    }
    case 'explorer': {
      const pid = spawnDetached(
        'explorer.exe',
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    case 'notepad': {
      const pid = spawnDetached(
        'notepad.exe',
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    default: {
      const exhaustive: never = app;
      throw new Error(`unsupported app: ${String(exhaustive)}`);
    }
  }
};
