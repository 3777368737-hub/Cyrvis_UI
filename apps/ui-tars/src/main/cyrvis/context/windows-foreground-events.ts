import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { DesktopHost, WindowInfo } from '../tools/types';

export interface WindowsForegroundEventOptions {
  desktop: DesktopHost;
  scriptPath?: string;
  onChange: (window: WindowInfo | null) => void;
  onError?: (error: Error) => void;
  restartDelayMs?: number;
}

const scriptCandidates = (configured?: string): string[] => [
  ...(configured ? [configured] : []),
  path.resolve(process.cwd(), 'scripts/cyrvis/foreground-events.ps1'),
  path.resolve(process.cwd(), '../../scripts/cyrvis/foreground-events.ps1'),
  path.resolve(
    process.resourcesPath || '',
    'scripts/cyrvis/foreground-events.ps1',
  ),
  path.resolve(process.resourcesPath || '', 'foreground-events.ps1'),
];

export class WindowsForegroundEventSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly restartDelayMs: number;

  constructor(private readonly options: WindowsForegroundEventOptions) {
    this.restartDelayMs = Math.max(500, options.restartDelayMs ?? 2_000);
  }

  start(): boolean {
    if (process.platform !== 'win32' || this.child || this.stopped) {
      return false;
    }
    if (!this.options.desktop.getForegroundWindow) {
      return false;
    }
    const script = scriptCandidates(this.options.scriptPath).find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!script) {
      return false;
    }
    this.stopped = false;
    try {
      this.child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ) as ChildProcessWithoutNullStreams;
      this.child.stdin.end();
    } catch (error) {
      this.reportError(error);
      return false;
    }
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('foreground:')) {
          continue;
        }
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
          void this.refreshForeground();
        }, 40);
        this.refreshTimer.unref?.();
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.options.onError?.(new Error(message));
      }
    });
    this.child.once('error', (error) => this.reportError(error));
    this.child.once('exit', () => {
      this.child = null;
      if (!this.stopped) {
        this.scheduleRestart();
      }
    });
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.child?.kill();
    this.child = null;
  }

  private async refreshForeground(): Promise<void> {
    try {
      this.options.onChange(
        (await this.options.desktop.getForegroundWindow?.()) || null,
      );
    } catch (error) {
      this.reportError(error);
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  private reportError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
