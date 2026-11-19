/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CapabilityCatalog } from './capability-catalog';
import type { ToolRegistry } from './registry';
import type {
  CapabilityDescriptor,
  ToolDefinition,
  ToolExposureTier,
} from './types';

export interface ToolSurfaceSnapshot {
  revision: number;
  registryRevision: number;
  visibleToolIds: string[];
  visibleDefinitions: ToolDefinition[];
  capabilities: CapabilityDescriptor[];
}

export interface ToolSurfaceOptions {
  maxVisibleTools?: number;
  activationTtlMs?: number;
  context?: ToolSurfaceContextAdapter;
}

export interface ToolSurfaceContextAdapter {
  getCapabilityBoost(capabilityId: string): number;
  shouldActivate(capability: CapabilityDescriptor): boolean;
  subscribe(listener: () => void): () => void;
}

export class ToolSurface {
  private readonly maxVisibleTools: number;
  private readonly activationTtlMs: number;
  private readonly contextAdapter?: ToolSurfaceContextAdapter;
  private readonly activations = new Map<string, number>();
  private readonly listeners = new Set<
    (snapshot: ToolSurfaceSnapshot) => void
  >();
  private readonly unsubscribeUsage: () => void;
  private readonly unsubscribeContext: (() => void) | null;
  private current: ToolSurfaceSnapshot;
  private currentRevision = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
    options: ToolSurfaceOptions = {},
  ) {
    this.maxVisibleTools = options.maxVisibleTools ?? 24;
    this.activationTtlMs = options.activationTtlMs ?? 10 * 60_000;
    this.contextAdapter = options.context;
    this.current = this.calculate();
    this.unsubscribeUsage = registry.subscribeUsage(() => this.refresh());
    this.unsubscribeContext =
      options.context?.subscribe(() => this.refresh()) ?? null;
  }

  snapshot(): ToolSurfaceSnapshot {
    return this.current;
  }

  isVisible(toolId: string): boolean {
    return this.current.visibleToolIds.includes(toolId);
  }

  activate(toolId: string): void {
    if (!this.registry.get(toolId)) {
      return;
    }
    this.activations.set(toolId, Date.now() + this.activationTtlMs);
    this.refresh();
  }

  refresh(): void {
    const next = this.calculate();
    const previousSignature = this.current.visibleToolIds.join('\0');
    const nextSignature = next.visibleToolIds.join('\0');
    const availabilityChanged =
      capabilitySignature(this.current.capabilities) !==
      capabilitySignature(next.capabilities);
    if (
      previousSignature === nextSignature &&
      !availabilityChanged &&
      this.current.registryRevision === next.registryRevision
    ) {
      return;
    }
    this.currentRevision += 1;
    next.revision = this.currentRevision;
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // Tool surface observers must not block state refreshes.
      }
    }
  }

  subscribe(listener: (snapshot: ToolSurfaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeUsage();
    this.unsubscribeContext?.();
    this.listeners.clear();
  }

  private calculate(): ToolSurfaceSnapshot {
    const now = Date.now();
    for (const [toolId, expiresAt] of this.activations) {
      if (expiresAt <= now) {
        this.activations.delete(toolId);
      }
    }

    const capabilities = this.catalog.list();
    const candidates = capabilities
      .filter(
        (capability) =>
          capability.availability === 'available' ||
          capability.availability === 'degraded',
      )
      .filter((capability) => this.shouldExpose(capability))
      .sort((left, right) => this.compareCapabilities(left, right));

    const selected = candidates.slice(0, this.maxVisibleTools);
    selected.sort((left, right) => this.compareCapabilities(left, right));

    const visibleDefinitions = selected
      .map((capability) => this.registry.get(capability.toolId))
      .filter((definition): definition is ToolDefinition =>
        Boolean(definition),
      );
    return {
      revision: this.currentRevision,
      registryRevision: this.registry.revision,
      visibleToolIds: selected.map((capability) => capability.toolId),
      visibleDefinitions,
      capabilities,
    };
  }

  private shouldExpose(capability: CapabilityDescriptor): boolean {
    if (this.activations.has(capability.id)) {
      return true;
    }
    if (capability.tier === 0 || capability.tier === 1) {
      return true;
    }
    if (this.contextAdapter?.shouldActivate(capability)) {
      return true;
    }
    if (capability.tier === 2) {
      return capability.activation === 'state';
    }
    return false;
  }

  private compareCapabilities(
    left: CapabilityDescriptor,
    right: CapabilityDescriptor,
  ): number {
    return (
      this.effectiveTierRank(left) - this.effectiveTierRank(right) ||
      this.effectivePriority(right) - this.effectivePriority(left) ||
      left.id.localeCompare(right.id)
    );
  }

  private effectiveTierRank(capability: CapabilityDescriptor): number {
    if (this.activations.has(capability.id)) {
      return -1;
    }
    const boost = this.contextAdapter?.getCapabilityBoost(capability.id) || 0;
    if (boost >= 25) {
      return 1;
    }
    return tierRank(capability.tier);
  }

  private effectivePriority(capability: CapabilityDescriptor): number {
    const now = Date.now();
    const recency = capability.usage.lastUsedAt
      ? Math.max(
          0,
          12 -
            Math.min(
              12,
              Math.floor((now - capability.usage.lastUsedAt) / 3_600_000),
            ),
        )
      : 0;
    const frequency = Math.min(
      6,
      Math.log2(capability.usage.successes + capability.usage.failures + 1) *
        1.5,
    );
    return (
      capability.priority +
      recency +
      frequency +
      (this.contextAdapter?.getCapabilityBoost(capability.id) || 0) +
      (this.activations.has(capability.id) ? 1_000 : 0)
    );
  }
}

const tierRank = (tier: ToolExposureTier): number => tier;

const capabilitySignature = (capabilities: CapabilityDescriptor[]): string =>
  capabilities
    .map(
      (capability) =>
        `${capability.id}:${capability.availability}:${capability.unavailableReason || ''}`,
    )
    .join('\0');
