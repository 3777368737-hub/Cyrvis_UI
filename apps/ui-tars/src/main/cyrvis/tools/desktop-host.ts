/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from './types';

const APPLICATION_ALIASES: Record<
  string,
  { command: string; process: string }
> = {
  记事本: { command: 'notepad.exe', process: 'notepad' },
  notepad: { command: 'notepad.exe', process: 'notepad' },
  计算器: { command: 'calc.exe', process: 'CalculatorApp' },
  calculator: { command: 'calc.exe', process: 'CalculatorApp' },
  画图: { command: 'mspaint.exe', process: 'mspaint' },
  paint: { command: 'mspaint.exe', process: 'mspaint' },
  资源管理器: { command: 'explorer.exe', process: 'explorer' },
  explorer: { command: 'explorer.exe', process: 'explorer' },
  文件资源管理器: { command: 'explorer.exe', process: 'explorer' },
  命令提示符: { command: 'cmd.exe', process: 'cmd' },
  terminal: { command: 'wt.exe', process: 'WindowsTerminal' },
  终端: { command: 'wt.exe', process: 'WindowsTerminal' },
  powershell: { command: 'powershell.exe', process: 'powershell' },
  vscode: { command: 'code.cmd', process: 'Code' },
  visualstudiocode: { command: 'code.cmd', process: 'Code' },
  code: { command: 'code.cmd', process: 'Code' },
  浏览器: { command: 'chrome.exe', process: 'chrome' },
  谷歌浏览器: { command: 'chrome.exe', process: 'chrome' },
  chrome浏览器: { command: 'chrome.exe', process: 'chrome' },
  chrome: { command: 'chrome.exe', process: 'chrome' },
  edge: { command: 'msedge.exe', process: 'msedge' },
  edge浏览器: { command: 'msedge.exe', process: 'msedge' },
  微软浏览器: { command: 'msedge.exe', process: 'msedge' },
  word: { command: 'winword.exe', process: 'WINWORD' },
  excel: { command: 'excel.exe', process: 'EXCEL' },
  powerpoint: { command: 'powerpnt.exe', process: 'POWERPNT' },
  vlc: { command: 'vlc.exe', process: 'vlc' },
  微信: { command: 'WeChat.exe', process: 'WeChat' },
  wechat: { command: 'WeChat.exe', process: 'WeChat' },
};

const normalizeAlias = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

export const isSupportedApplicationAlias = (value: string): boolean =>
  Boolean(APPLICATION_ALIASES[normalizeAlias(value)]);

const runPowerShell = (script: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<string>((resolve, reject) => {
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
        env: { ...process.env, ...env },
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
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

const launchDetached = (command: string, args: string[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });

const WINDOW_CONTROL_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CyrvisWindow {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(
    IntPtr hWnd,
    uint Msg,
    IntPtr wParam,
    IntPtr lParam
  );
}
"@
$query = $env:CYRV_WINDOW_QUERY
$action = $env:CYRV_WINDOW_ACTION
$target = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    $_.ProcessName -like "*$query*" -or $_.MainWindowTitle -like "*$query*"
  )
} | Select-Object -First 1
if (-not $target) { throw "No matching window: $query" }
if ($action -eq "focus") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 9)
  [void][CyrvisWindow]::SetForegroundWindow($target.MainWindowHandle)
} elseif ($action -eq "minimize") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 6)
} elseif ($action -eq "maximize") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 3)
} elseif ($action -eq "close") {
  [void][CyrvisWindow]::PostMessage(
    $target.MainWindowHandle,
    0x0010,
    [IntPtr]::Zero,
    [IntPtr]::Zero
  )
} else {
  throw "Unknown window action: $action"
}
Write-Output ($target.ProcessName + "|" + $target.MainWindowTitle)
`;

const unsupported = (feature: string): never => {
  throw new Error(`${feature} is currently implemented for Windows only`);
};

export class LocalDesktopHost implements DesktopHost {
  async openPath(target: string): Promise<void> {
    await this.openTarget(target);
  }

  async openUrl(url: string): Promise<void> {
    await this.openTarget(url);
  }

  async clipboardRead(): Promise<string> {
    if (process.platform === 'win32') {
      return runPowerShell('Get-Clipboard -Raw');
    }
    if (process.platform === 'darwin') {
      return new Promise<string>((resolve, reject) => {
        execFile('pbpaste', [], (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      });
    }
    return new Promise<string>((resolve, reject) => {
      execFile('xclip', ['-selection', 'clipboard', '-o'], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
  }

  async clipboardWrite(text: string): Promise<void> {
    if (process.platform === 'win32') {
      await runPowerShell('Set-Clipboard -Value $env:CYRV_CLIPBOARD_TEXT', {
        CYRV_CLIPBOARD_TEXT: text,
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const command = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
      const args =
        process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
      const child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
      child.stdin.end(text);
    });
  }

  async launchApplication(name: string): Promise<string> {
    const alias = APPLICATION_ALIASES[normalizeAlias(name)];
    if (!alias) {
      throw new Error(`Unsupported application alias: ${name}`);
    }
    if (process.platform === 'win32') {
      await runPowerShell('Start-Process -FilePath $env:CYRV_APP_COMMAND', {
        CYRV_APP_COMMAND: alias.command,
      });
    } else {
      await launchDetached(alias.command);
    }
    return name.trim();
  }

  async closeApplication(name: string): Promise<string> {
    if (process.platform !== 'win32') {
      return unsupported('Closing applications');
    }
    const alias = APPLICATION_ALIASES[normalizeAlias(name)];
    const processName = alias?.process || name.trim();
    if (!/^[A-Za-z0-9_.-]+$/i.test(processName)) {
      throw new Error(
        'Application process name contains unsupported characters',
      );
    }
    await runPowerShell(
      '$name = $env:CYRV_APP_PROCESS; Get-Process -Name $name -ErrorAction Stop | Stop-Process -Force',
      { CYRV_APP_PROCESS: processName },
    );
    return name.trim();
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    if (process.platform !== 'win32') {
      return this.listUnixProcesses();
    }
    const output = await runPowerShell(`
$items = Get-Process | Sort-Object -Property ProcessName | ForEach-Object {
  [pscustomobject]@{
    pid = $_.Id
    name = $_.ProcessName
    title = $_.MainWindowTitle
    memoryBytes = $_.WorkingSet64
  }
}
$items | ConvertTo-Json -Compress
`);
    const parsed = parseJson<ProcessInfo[] | ProcessInfo>(output, []);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (item) => item && typeof item.pid === 'number',
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    const processes = await this.listProcesses();
    return processes
      .filter((processInfo) => Boolean(processInfo.title?.trim()))
      .map((processInfo) => ({
        pid: processInfo.pid,
        process: processInfo.name,
        title: processInfo.title || '',
      }));
  }

  async controlWindow(
    query: string,
    action: 'focus' | 'minimize' | 'maximize' | 'close',
  ): Promise<string> {
    if (process.platform !== 'win32') {
      return unsupported('Window control');
    }
    const output = await runPowerShell(WINDOW_CONTROL_SCRIPT, {
      CYRV_WINDOW_QUERY: query,
      CYRV_WINDOW_ACTION: action,
    });
    const [processName, title] = output.split('|');
    return title || processName || query;
  }

  async minimizeAllWindows(): Promise<number> {
    if (process.platform !== 'win32') {
      return unsupported('Minimize all windows');
    }
    const count = (await this.listWindows()).length;
    await runPowerShell(
      '$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()',
    );
    return count;
  }

  async restoreAllWindows(): Promise<number> {
    if (process.platform !== 'win32') {
      return unsupported('Restore all windows');
    }
    const count = (await this.listWindows()).length;
    await runPowerShell(
      '$shell = New-Object -ComObject Shell.Application; $shell.UndoMinimizeALL()',
    );
    return count;
  }

  async createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void> {
    if (process.platform !== 'win32') {
      return unsupported('PowerPoint presentation creation');
    }
    const script = `
$ppt = $null
$presentation = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $presentation = $ppt.Presentations.Add($false)
  $slide = $presentation.Slides.Add(1, 1)
  try {
    $slide.Shapes.Title.TextFrame.TextRange.Text = $env:CYRV_PPT_TITLE
  } catch {}
  if ($env:CYRV_PPT_SUBTITLE) {
    try {
      $slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = $env:CYRV_PPT_SUBTITLE
    } catch {}
  }
  $presentation.SaveAs($env:CYRV_PPT_PATH)
} finally {
  if ($presentation) {
    try { $presentation.Close() } catch {}
  }
  if ($ppt) {
    try { $ppt.Quit() } catch {}
  }
}`;
    await runPowerShell(script, {
      CYRV_PPT_PATH: input.path,
      CYRV_PPT_TITLE: input.title,
      CYRV_PPT_SUBTITLE: input.subtitle || '',
    });
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: process.platform,
      release: os.release(),
      architecture: os.arch(),
      hostname: os.hostname(),
      homeDirectory: os.homedir(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    };
  }

  async diskInfo(target: string): Promise<DiskInfo> {
    const stats = await fs.statfs(target);
    return {
      path: target,
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
    };
  }

  private async openTarget(target: string): Promise<void> {
    if (process.platform === 'win32') {
      await runPowerShell('Start-Process -FilePath $env:CYRV_TOOL_TARGET', {
        CYRV_TOOL_TARGET: target,
      });
      return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    await new Promise<void>((resolve, reject) => {
      execFile(command, [target], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private async listUnixProcesses(): Promise<ProcessInfo[]> {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-eo', 'pid=,comm=,rss='],
        { maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const processes = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+?)\s+(\d+)$/);
        if (!match) {
          return null;
        }
        return {
          pid: Number(match[1]),
          name: match[2],
          memoryBytes: Number(match[3]) * 1024,
        } satisfies ProcessInfo;
      });
    return processes.filter(
      (item): item is NonNullable<(typeof processes)[number]> => item !== null,
    );
  }
}
