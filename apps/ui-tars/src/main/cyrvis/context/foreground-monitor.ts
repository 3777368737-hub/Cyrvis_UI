import type { DesktopHost, WindowInfo } from '../tools/types';

export interface ForegroundMonitorOptions {
  intervalMs?: number;
  onChange: (window: WindowInfo | null) => void;
}

const windowKey = (window: WindowInfo | null): string =>
  window
    ? `${window.handle ?? ''}:${window.pid}:${window.process}:${window.title}`
    : '';

export class ForegroundMonitor {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentKey = '';
  private polling = false;

  constructor(
    private readonly desktop: DesktopHost,
    private readonly options: ForegroundMonitorOptions,
  ) {
    this.intervalMs = Math.max(500, options.intervalMs ?? 2_000);
  }

  start(): void {
    if (this.timer || !this.desktop.getForegroundWindow) {
      return;
    }
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.desktop.getForegroundWindow) {
      return;
    }
    this.polling = true;
    try {
      const window = (await this.desktop.getForegroundWindow()) || null;
      const nextKey = windowKey(window);
      if (nextKey === this.currentKey) {
        return;
      }
      this.currentKey = nextKey;
      this.options.onChange(window);
    } catch {
      // Foreground polling is best-effort; the next interval retries.
    } finally {
      this.polling = false;
    }
  }
}
