/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CapabilityAvailability, ToolPermission } from './types';
import type {
  ProviderManifest,
  ProviderRuntimeDescriptor,
} from './provider-types';

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRuntimeDescriptor>();
  private readonly listeners = new Set<
    (providers: ProviderRuntimeDescriptor[]) => void
  >();
  private currentRevision = 0;

  register(
    manifest: ProviderManifest,
    source: string,
  ): ProviderRuntimeDescriptor {
    const existing = this.providers.get(manifest.id);
    if (existing && existing.source !== source) {
      throw new Error(
        `Provider ${manifest.id} is already registered from ${existing.source}`,
      );
    }
    if (existing && existing.manifest.version !== manifest.version) {
      throw new Error(
        `Provider ${manifest.id} is already registered at version ${existing.manifest.version}`,
      );
    }
    const descriptor: ProviderRuntimeDescriptor = {
      manifest,
      source,
      availability: existing?.availability || 'unknown',
      unavailableReason: existing?.unavailableReason || null,
      toolIds:
        manifest.transport.type === 'builtin'
          ? manifest.transport.toolIds || []
          : existing?.toolIds || [],
      connectedAt: existing?.connectedAt || null,
      lastHealthCheckAt: existing?.lastHealthCheckAt || null,
      lastError: existing?.lastError || null,
    };
    this.providers.set(manifest.id, descriptor);
    this.emit();
    return descriptor;
  }

  unregister(providerId: string): boolean {
    const deleted = this.providers.delete(providerId);
    if (deleted) {
      this.emit();
    }
    return deleted;
  }

  get(providerId: string): ProviderRuntimeDescriptor | null {
    return this.providers.get(providerId) || null;
  }

  list(): ProviderRuntimeDescriptor[] {
    return [...this.providers.values()].sort((left, right) =>
      left.manifest.id.localeCompare(right.manifest.id),
    );
  }

  updateStatus(
    providerId: string,
    update: {
      availability: CapabilityAvailability;
      unavailableReason?: string | null;
      toolIds?: string[];
      connectedAt?: number | null;
      lastHealthCheckAt?: number | null;
      lastError?: string | null;
    },
  ): ProviderRuntimeDescriptor | null {
    const current = this.providers.get(providerId);
    if (!current) {
      return null;
    }
    const next: ProviderRuntimeDescriptor = {
      ...current,
      availability: update.availability,
      unavailableReason:
        update.unavailableReason === undefined
          ? current.unavailableReason
          : update.unavailableReason,
      toolIds: update.toolIds || current.toolIds,
      connectedAt:
        update.connectedAt === undefined
          ? current.connectedAt
          : update.connectedAt,
      lastHealthCheckAt:
        update.lastHealthCheckAt === undefined
          ? current.lastHealthCheckAt
          : update.lastHealthCheckAt,
      lastError:
        update.lastError === undefined ? current.lastError : update.lastError,
    };
    if (
      next.availability === current.availability &&
      next.unavailableReason === current.unavailableReason &&
      next.toolIds.join('\0') === current.toolIds.join('\0') &&
      next.connectedAt === current.connectedAt &&
      next.lastHealthCheckAt === current.lastHealthCheckAt &&
      next.lastError === current.lastError
    ) {
      return current;
    }
    this.providers.set(providerId, next);
    this.emit();
    return next;
  }

  permissionsFor(providerId: string): ToolPermission[] {
    return this.providers.get(providerId)?.manifest.permissions || [];
  }

  subscribe(
    listener: (providers: ProviderRuntimeDescriptor[]) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get revision(): number {
    return this.currentRevision;
  }

  private emit(): void {
    this.currentRevision += 1;
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Provider observers must not block registration.
      }
    }
  }
}
