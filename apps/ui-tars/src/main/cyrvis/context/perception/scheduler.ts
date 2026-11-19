import { IncrementalResourceStore } from './resource-store';
import type {
  PerceptionContext,
  PerceptionProvider,
  PerceptionProviderSnapshot,
} from './types';

export interface PerceptionSchedulerOptions {
  providers: PerceptionProvider[];
  resources: IncrementalResourceStore;
  context(): PerceptionContext;
  minIntervalMs?: number;
  maxBackoffMs?: number;
  onResourcesChanged?(): void;
  onStatusChanged?(): void;
}

interface ProviderRuntime {
  provider: PerceptionProvider;
  status: PerceptionProviderSnapshot;
  signature: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  queued: boolean;
  registered: boolean;
}

const statusSignature = (status: PerceptionProviderSnapshot): string =>
  JSON.stringify({
    state: status.state,
    resourceCount: status.resourceCount,
    consecutiveFailures: status.consecutiveFailures,
    error: status.error,
  });

export class PerceptionScheduler {
  private readonly runtimes = new Map<string, ProviderRuntime>();
  private readonly minIntervalMs: number;
  private readonly maxBackoffMs: number;
  private started = false;

  constructor(private readonly options: PerceptionSchedulerOptions) {
    this.minIntervalMs = Math.max(250, options.minIntervalMs ?? 500);
    this.maxBackoffMs = Math.max(
      this.minIntervalMs,
      options.maxBackoffMs ?? 60_000,
    );
    for (const provider of options.providers) {
      this.addProvider(provider);
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const runtime of this.runtimes.values()) {
      this.schedule(runtime, 0);
    }
  }

  stop(): void {
    this.started = false;
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) {
        clearTimeout(runtime.timer);
        runtime.timer = null;
      }
      void runtime.provider.dispose?.();
    }
  }

  registerProvider(provider: PerceptionProvider): void {
    this.addProvider(provider);
    this.options.onStatusChanged?.();
    if (this.started) {
      this.schedule(this.runtimes.get(provider.id)!, 0);
    }
  }

  unregisterProvider(providerId: string): void {
    const runtime = this.runtimes.get(providerId);
    if (!runtime) {
      return;
    }
    if (runtime.timer) {
      clearTimeout(runtime.timer);
    }
    runtime.registered = false;
    void runtime.provider.dispose?.();
    this.runtimes.delete(providerId);
    const change = this.options.resources.removeProvider(providerId);
    if (change) {
      this.options.onResourcesChanged?.();
    }
    this.options.onStatusChanged?.();
  }

  listStatuses(): PerceptionProviderSnapshot[] {
    return [...this.runtimes.values()]
      .map((runtime) => ({ ...runtime.status }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async refreshProvider(providerId: string): Promise<void> {
    const runtime = this.runtimes.get(providerId);
    if (!runtime || !this.started) {
      return;
    }
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    await this.startRefresh(runtime);
  }

  async refreshForTool(toolId: string): Promise<void> {
    const targets = [...this.runtimes.values()].filter((runtime) =>
      runtime.provider.triggerToolIds?.includes(toolId),
    );
    await Promise.all(
      targets.map((runtime) => this.refreshProvider(runtime.provider.id)),
    );
  }

  async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((providerId) =>
        this.refreshProvider(providerId),
      ),
    );
  }

  private schedule(runtime: ProviderRuntime, delayMs: number): void {
    if (!this.started || !runtime.registered) {
      return;
    }
    if (runtime.timer) {
      clearTimeout(runtime.timer);
    }
    const delay = Math.max(0, delayMs);
    runtime.status.nextRefreshAt = Date.now() + delay;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void this.runScheduled(runtime);
    }, delay);
    runtime.timer.unref?.();
  }

  private addProvider(provider: PerceptionProvider): void {
    if (this.runtimes.has(provider.id)) {
      throw new Error(`Duplicate perception provider: ${provider.id}`);
    }
    const status: PerceptionProviderSnapshot = {
      id: provider.id,
      state: 'idle',
      lastRefreshAt: null,
      lastSuccessAt: null,
      nextRefreshAt: null,
      durationMs: null,
      resourceCount: 0,
      consecutiveFailures: 0,
      error: null,
    };
    this.runtimes.set(provider.id, {
      provider,
      status,
      signature: statusSignature(status),
      timer: null,
      inFlight: null,
      queued: false,
      registered: true,
    });
  }

  private async runScheduled(runtime: ProviderRuntime): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.startRefresh(runtime);
  }

  private startRefresh(runtime: ProviderRuntime): Promise<void> {
    if (runtime.inFlight) {
      runtime.queued = true;
      return runtime.inFlight;
    }
    runtime.inFlight = (async () => {
      do {
        runtime.queued = false;
        await this.refresh(runtime);
      } while (runtime.queued && this.started && runtime.registered);
    })().finally(() => {
      runtime.inFlight = null;
    });
    return runtime.inFlight;
  }

  private async refresh(runtime: ProviderRuntime): Promise<void> {
    if (!this.started || !runtime.registered) {
      return;
    }
    const startedAt = Date.now();
    runtime.status.lastRefreshAt = startedAt;
    runtime.status.nextRefreshAt = null;

    const timeoutMs = Math.max(250, runtime.provider.timeoutMs ?? 5_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const resources = await runtime.provider.refresh(
        this.options.context(),
        controller.signal,
      );
      if (!this.started || !runtime.registered) {
        return;
      }
      const change = this.options.resources.replaceProvider(
        runtime.provider.id,
        resources,
        {
          observedAt: Date.now(),
          ttlMs:
            runtime.provider.ttlMs ??
            Math.max(5_000, runtime.provider.intervalMs * 3),
        },
      );
      this.schedule(
        runtime,
        Math.max(this.minIntervalMs, runtime.provider.intervalMs),
      );
      this.updateStatus(runtime, {
        state: 'healthy',
        lastSuccessAt: Date.now(),
        durationMs: Date.now() - startedAt,
        resourceCount: resources.length,
        consecutiveFailures: 0,
        error: null,
      });
      if (change) {
        this.options.onResourcesChanged?.();
      }
    } catch (error) {
      const message = controller.signal.aborted
        ? `Refresh timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      const failures = runtime.status.consecutiveFailures + 1;
      const resourcesPruned = this.options.resources.prune(Date.now());
      const backoff = Math.min(
        this.maxBackoffMs,
        Math.max(
          this.minIntervalMs,
          Math.max(this.minIntervalMs, runtime.provider.intervalMs) *
            2 ** Math.min(failures, 6),
        ),
      );
      this.schedule(runtime, backoff);
      this.updateStatus(runtime, {
        state: 'degraded',
        durationMs: Date.now() - startedAt,
        resourceCount: this.options.resources.countProvider(
          runtime.provider.id,
          Date.now(),
        ),
        consecutiveFailures: failures,
        error: message,
      });
      if (resourcesPruned) {
        this.options.onResourcesChanged?.();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private updateStatus(
    runtime: ProviderRuntime,
    patch: Partial<PerceptionProviderSnapshot>,
  ): void {
    runtime.status = {
      ...runtime.status,
      ...patch,
    };
    const nextSignature = statusSignature(runtime.status);
    if (nextSignature === runtime.signature) {
      return;
    }
    runtime.signature = nextSignature;
    this.options.onStatusChanged?.();
  }
}
