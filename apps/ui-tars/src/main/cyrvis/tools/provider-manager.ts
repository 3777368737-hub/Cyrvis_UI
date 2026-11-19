/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import type { SystemStateStore } from '../system/system-state';
import { ExternalMcpProvider } from './external-mcp-provider';
import { loadProviderManifests } from './provider-manifest';
import { ProviderRegistry } from './provider-registry';
import { evaluateRequirements } from './provider-requirements';
import type {
  ProviderManifest,
  ProviderRuntimeDescriptor,
} from './provider-types';
import type { ToolRegistry } from './registry';
import type { ToolPermission, WindowInfo } from './types';

export interface ProviderManagerOptions {
  manifestDirectories?: string[];
  publicKeyPem?: string;
  allowUntrusted?: boolean;
  deniedPermissions?: ToolPermission[];
  healthCheckIntervalMs?: number;
  foregroundWindow?: () => WindowInfo | null;
}

interface ActiveExternalProvider {
  client: ExternalMcpProvider;
  manifest: ProviderManifest;
  toolIds: string[];
}

const splitList = (value: string | undefined): string[] =>
  (value || '')
    .split(/[;\r\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

export class ProviderManager {
  private readonly manifestDirectories: string[];
  private readonly publicKeyPem?: string;
  private readonly allowUntrusted: boolean;
  private readonly deniedPermissions: ToolPermission[];
  private readonly healthCheckIntervalMs: number;
  private readonly foregroundWindow?: () => WindowInfo | null;
  private readonly clients = new Map<string, ExternalMcpProvider>();
  private readonly external = new Map<string, ActiveExternalProvider>();
  private readonly retryAt = new Map<string, number>();
  private readonly loadedManifests = new Map<string, string>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeState: (() => void) | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly providers: ProviderRegistry,
    private readonly systemState?: SystemStateStore,
    options: ProviderManagerOptions = {},
  ) {
    this.manifestDirectories = (
      options.manifestDirectories ||
      splitList(process.env.CYRVIS_PROVIDER_MANIFEST_DIRS)
    ).map((directory) => path.resolve(directory));
    this.publicKeyPem =
      options.publicKeyPem || process.env.CYRVIS_PROVIDER_PUBLIC_KEY;
    this.allowUntrusted =
      options.allowUntrusted ??
      (process.env.CYRV_ALLOW_UNTRUSTED_PROVIDERS === '1' ||
        process.env.CYRVIS_ALLOW_UNTRUSTED_PROVIDERS === '1');
    this.deniedPermissions =
      options.deniedPermissions ||
      (splitList(
        process.env.CYRVIS_DENIED_TOOL_PERMISSIONS,
      ) as ToolPermission[]);
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30_000;
    this.foregroundWindow = options.foregroundWindow;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.loadManifests();
    this.unsubscribeState =
      this.systemState?.onChange(() => {
        void this.reconcile();
      }) ?? null;
    const requestedIntervals = this.providers
      .list()
      .map((provider) => provider.manifest.healthCheckIntervalMs)
      .filter(
        (interval): interval is number =>
          typeof interval === 'number' && interval >= 1_000,
      );
    this.healthTimer = setInterval(
      () => {
        void this.healthCheck();
      },
      Math.min(this.healthCheckIntervalMs, ...requestedIntervals),
    );
    this.healthTimer.unref?.();
    await this.reconcile();
  }

  private async loadManifests(): Promise<void> {
    const seenSources = new Set<string>();
    for (const directory of this.manifestDirectories) {
      const result = await loadProviderManifests(directory, {
        publicKeyPem: this.publicKeyPem,
        allowUntrusted: this.allowUntrusted,
      });
      for (const loaded of result.manifests) {
        seenSources.add(loaded.source);
        const previousProviderId = this.loadedManifests.get(loaded.source);
        if (previousProviderId && previousProviderId !== loaded.manifest.id) {
          await this.removeProvider(previousProviderId);
        }
        const existing = this.providers.get(loaded.manifest.id);
        if (
          existing &&
          (existing.manifest.version !== loaded.manifest.version ||
            JSON.stringify(existing.manifest) !==
              JSON.stringify(loaded.manifest))
        ) {
          await this.removeProvider(loaded.manifest.id);
        }
        try {
          this.providers.register(loaded.manifest, loaded.source);
          if (loaded.manifest.transport.type !== 'builtin') {
            const client = new ExternalMcpProvider(loaded.manifest);
            this.clients.set(loaded.manifest.id, client);
            const declared = client.declaredDefinitions();
            this.registry.replaceProvider(loaded.manifest.id, declared);
            this.providers.updateStatus(loaded.manifest.id, {
              availability:
                this.providers.get(loaded.manifest.id)?.availability ||
                'unknown',
              toolIds: declared.map((definition) => definition.name),
            });
          }
          this.loadedManifests.set(loaded.source, loaded.manifest.id);
        } catch (error) {
          console.warn('[cyrvis provider] registration failed', {
            source: loaded.source,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const error of result.errors) {
        seenSources.add(error.source);
        const previousProviderId = this.loadedManifests.get(error.source);
        if (previousProviderId) {
          await this.removeProvider(previousProviderId);
          this.loadedManifests.delete(error.source);
        }
        console.warn('[cyrvis provider] manifest rejected', error);
      }
    }
    for (const [source, providerId] of [...this.loadedManifests.entries()]) {
      if (seenSources.has(source)) {
        continue;
      }
      await this.removeProvider(providerId);
      this.loadedManifests.delete(source);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const providerId of [...this.external.keys()]) {
      await this.deactivate(providerId);
    }
  }

  list(): ProviderRuntimeDescriptor[] {
    return this.providers.list();
  }

  async reload(): Promise<void> {
    await this.start();
    await this.loadManifests();
    await this.reconcile();
  }

  async refresh(): Promise<void> {
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.reconcileProviders().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async reconcileProviders(): Promise<void> {
    const snapshot = this.systemState?.getSnapshot() || null;
    const now = Date.now();
    for (const provider of this.providers.list()) {
      const manifest = provider.manifest;
      if (manifest.enabled === false) {
        await this.deactivate(manifest.id);
        this.providers.updateStatus(manifest.id, {
          availability: 'unavailable',
          unavailableReason: 'Provider 已在 manifest 中禁用。',
        });
        continue;
      }
      const evaluation = evaluateRequirements(
        manifest.requirements || {},
        snapshot,
        this.deniedPermissions,
      );
      if (!evaluation.available) {
        await this.deactivate(manifest.id);
        this.providers.updateStatus(manifest.id, {
          availability: snapshot?.capturedAt ? 'unavailable' : 'unknown',
          unavailableReason: evaluation.reason,
          lastError: evaluation.reason,
        });
        continue;
      }
      if (
        manifest.transport.type !== 'builtin' &&
        !this.matchesForegroundActivation(manifest, snapshot)
      ) {
        await this.deactivate(manifest.id);
        this.providers.updateStatus(manifest.id, {
          availability: 'unknown',
          unavailableReason: 'Provider 正在等待匹配的前台应用。',
          lastError: null,
        });
        continue;
      }
      if (manifest.transport.type === 'builtin') {
        this.providers.updateStatus(manifest.id, {
          availability: 'available',
          unavailableReason: null,
          toolIds: manifest.transport.toolIds || [],
          lastError: null,
        });
        continue;
      }
      if (this.external.has(manifest.id)) {
        this.providers.updateStatus(manifest.id, {
          availability: 'available',
          unavailableReason: null,
        });
        continue;
      }
      if ((this.retryAt.get(manifest.id) || 0) > now) {
        continue;
      }
      await this.activate(manifest);
    }
  }

  private async activate(manifest: ProviderManifest): Promise<void> {
    if (
      !manifest.permissions?.includes('process.spawn') &&
      manifest.transport.type === 'stdio'
    ) {
      this.providers.updateStatus(manifest.id, {
        availability: 'unavailable',
        unavailableReason: 'stdio Provider 缺少 process.spawn 权限。',
      });
      return;
    }
    if (
      !manifest.permissions?.includes('remote.tools') &&
      manifest.transport.type !== 'stdio'
    ) {
      this.providers.updateStatus(manifest.id, {
        availability: 'unavailable',
        unavailableReason: '远程 Provider 缺少 remote.tools 权限。',
      });
      return;
    }
    const client =
      this.clients.get(manifest.id) || new ExternalMcpProvider(manifest);
    this.clients.set(manifest.id, client);
    try {
      const definitions = await client.connect();
      for (const definition of definitions) {
        const required = definition.capability?.permissions || [];
        const missing = required.find(
          (permission) => !manifest.permissions?.includes(permission),
        );
        if (missing) {
          throw new Error(
            `Tool ${definition.name} requires undeclared permission ${missing}`,
          );
        }
      }
      this.registry.replaceProvider(manifest.id, definitions);
      this.external.set(manifest.id, {
        client,
        manifest,
        toolIds: definitions.map((definition) => definition.name),
      });
      this.retryAt.delete(manifest.id);
      this.providers.updateStatus(manifest.id, {
        availability: 'available',
        unavailableReason: null,
        toolIds: definitions.map((definition) => definition.name),
        connectedAt: Date.now(),
        lastHealthCheckAt: Date.now(),
        lastError: null,
      });
    } catch (error) {
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      this.retryAt.set(manifest.id, Date.now() + 60_000);
      this.providers.updateStatus(manifest.id, {
        availability: 'degraded',
        unavailableReason: message,
        lastError: message,
      });
    }
  }

  private async deactivate(providerId: string): Promise<void> {
    const active = this.external.get(providerId);
    if (!active) {
      return;
    }
    await active.client.close();
    this.external.delete(providerId);
  }

  private async removeProvider(providerId: string): Promise<void> {
    await this.deactivate(providerId);
    this.clients.delete(providerId);
    this.registry.replaceProvider(providerId, []);
    this.providers.unregister(providerId);
  }

  private async healthCheck(): Promise<void> {
    for (const [providerId, active] of [...this.external.entries()]) {
      const healthy = await active.client.healthCheck();
      if (healthy) {
        this.providers.updateStatus(providerId, {
          availability: 'available',
          lastHealthCheckAt: Date.now(),
          lastError: null,
        });
        continue;
      }
      await this.deactivate(providerId);
      this.retryAt.set(providerId, Date.now() + 30_000);
      this.providers.updateStatus(providerId, {
        availability: 'degraded',
        unavailableReason: 'Provider 健康检查失败，等待重连。',
        lastHealthCheckAt: Date.now(),
        lastError: 'health check failed',
      });
    }
    await this.reconcile();
  }

  private matchesForegroundActivation(
    manifest: ProviderManifest,
    snapshot: ReturnType<SystemStateStore['getSnapshot']> | null,
  ): boolean {
    if (manifest.activation?.mode !== 'foreground') {
      return true;
    }
    const foreground =
      this.foregroundWindow?.() ||
      snapshot?.windows.find((window) => window.focused) ||
      null;
    if (!foreground) {
      return false;
    }
    const applications = manifest.activation.applications || [];
    const processes = manifest.activation.processes || [];
    if (!applications.length && !processes.length) {
      return true;
    }
    const process = normalize(foreground.process);
    const title = normalize(foreground.title);
    return (
      processes.some((entry) => {
        const target = normalize(entry);
        return process.includes(target) || title.includes(target);
      }) ||
      applications.some((entry) => {
        const target = normalize(entry);
        return title.includes(target) || process.includes(target);
      })
    );
  }
}
