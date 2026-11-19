import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { SystemStateStore } from '../../src/main/cyrvis/system/system-state';
import { createFastToolMatrix } from '../../src/main/cyrvis/tools/matrix';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from '../../src/main/cyrvis/tools/types';

class BenchmarkDesktop implements DesktopHost {
  readonly applications = Array.from({ length: 300 }, (_, index) => ({
    id: `app-${index}`,
    name: `Benchmark Application ${index}`,
    source: 'registry' as const,
    executable: `C:\\Apps\\benchmark-${index}.exe`,
  }));
  readonly windows = Array.from({ length: 80 }, (_, index) => ({
    pid: index + 1,
    process: `BenchmarkApp${index}`,
    title: `Benchmark Window ${index}`,
    focused: index === 0,
    handle: index + 100,
  }));

  async openPath(): Promise<void> {
    return undefined;
  }
  async openUrl(): Promise<void> {
    return undefined;
  }
  async clipboardRead(): Promise<string> {
    return '';
  }
  async clipboardWrite(): Promise<void> {
    return undefined;
  }
  async launchApplication(name: string): Promise<string> {
    return name;
  }
  async closeApplication(name: string): Promise<string> {
    return name;
  }
  async listProcesses(): Promise<ProcessInfo[]> {
    return this.windows.map((window) => ({
      pid: window.pid,
      name: window.process,
      title: window.title,
    }));
  }
  async listWindows(): Promise<WindowInfo[]> {
    return this.windows;
  }
  async getForegroundWindow(): Promise<WindowInfo> {
    return this.windows[0];
  }
  async controlWindow(query: string): Promise<string> {
    return query;
  }
  async minimizeAllWindows(): Promise<number> {
    return this.windows.length;
  }
  async restoreAllWindows(): Promise<number> {
    return this.windows.length;
  }
  async createPresentation(): Promise<void> {
    return undefined;
  }
  async showNotification(): Promise<void> {
    return undefined;
  }
  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: process.platform,
      release: 'benchmark',
      architecture: 'x64',
      hostname: 'cyrvis-benchmark',
      homeDirectory: os.homedir(),
      cpuCount: 8,
      totalMemoryBytes: 16,
      freeMemoryBytes: 8,
      uptimeSeconds: 100,
    };
  }
  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 1, freeBytes: 1 };
  }
}

const percentile = (values: number[], ratio: number): number => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))
  ];
};

const main = async () => {
  const host = new BenchmarkDesktop();
  const store = new SystemStateStore(host, {
    staleMs: 60_000,
    discoverers: {
      applications: async () => host.applications,
      steam: async () => ({ root: null, games: [] }),
      disks: async () => [],
      battery: async () => null,
      services: async () => [],
      recentFiles: async () => [],
    },
  });
  await store.refresh(true);
  const matrix = createFastToolMatrix(host, process.cwd(), store);

  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    matrix.dynamicContext.refresh();
    matrix.surface.refresh();
    samples.push(performance.now() - started);
  }

  console.log(
    JSON.stringify(
      {
        resources: matrix.dynamicContext.getSnapshot().resources.length,
        bindings: matrix.dynamicContext.getSnapshot().bindings.length,
        registryTools: matrix.registry.list().length,
        visibleTools: matrix.surface.snapshot().visibleToolIds.length,
        p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
        p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
        maxMs: Number(Math.max(...samples).toFixed(3)),
      },
      null,
      2,
    ),
  );

  matrix.dispose();
  store.stop();
  process.exit(0);
};

void main();
