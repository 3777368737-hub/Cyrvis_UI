import type { ResourceDescriptor } from '../types';
import type { ResourceStoreChange } from './types';

interface StoredResource {
  resource: ResourceDescriptor;
  expiresAt: number;
  signature: string;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

const resourceSignature = (resource: ResourceDescriptor): string =>
  JSON.stringify({
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    aliases: resource.aliases,
    source: resource.source,
    health: resource.health,
    providerIds: resource.providerIds,
    capabilities: resource.capabilities,
    parentId: resource.parentId || null,
    metadata: stableValue(resource.metadata),
  });

export class IncrementalResourceStore {
  private readonly byProvider = new Map<string, Map<string, StoredResource>>();
  private currentRevision = 0;

  get revision(): number {
    return this.currentRevision;
  }

  replaceProvider(
    providerId: string,
    resources: ResourceDescriptor[],
    options: { observedAt: number; ttlMs: number },
  ): ResourceStoreChange | null {
    const previous = this.byProvider.get(providerId) || new Map();
    const next = new Map<string, StoredResource>();
    const upserted: string[] = [];
    const expiresAt = options.observedAt + Math.max(1, options.ttlMs);

    for (const resource of resources) {
      const signature = resourceSignature(resource);
      const existing = previous.get(resource.id);
      if (!existing || existing.signature !== signature) {
        upserted.push(resource.id);
      }
      next.set(resource.id, {
        resource:
          existing && existing.signature === signature
            ? {
                ...existing.resource,
                lastSeenAt: options.observedAt,
                expiresAt,
              }
            : {
                ...resource,
                updatedAt: options.observedAt,
                lastSeenAt: options.observedAt,
                expiresAt,
              },
        expiresAt,
        signature,
      });
    }

    const removed = [...previous.keys()].filter((id) => !next.has(id));
    if (next.size) {
      this.byProvider.set(providerId, next);
    } else {
      this.byProvider.delete(providerId);
    }
    return this.commit(providerId, options.observedAt, upserted, removed);
  }

  removeProvider(
    providerId: string,
    at = Date.now(),
  ): ResourceStoreChange | null {
    const previous = this.byProvider.get(providerId);
    if (!previous) {
      return null;
    }
    this.byProvider.delete(providerId);
    return this.commit(providerId, at, [], [...previous.keys()]);
  }

  list(now = Date.now()): ResourceDescriptor[] {
    this.prune(now);
    return [...this.byProvider.values()]
      .flatMap((resources) => [...resources.values()])
      .map((entry) => entry.resource)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  countProvider(providerId: string, now = Date.now()): number {
    this.prune(now);
    return this.byProvider.get(providerId)?.size || 0;
  }

  prune(now = Date.now()): boolean {
    let changed = false;
    for (const [providerId, resources] of [...this.byProvider.entries()]) {
      const removed = [...resources.entries()]
        .filter(([, entry]) => entry.expiresAt <= now)
        .map(([id]) => id);
      if (!removed.length) {
        continue;
      }
      for (const id of removed) {
        resources.delete(id);
      }
      if (!resources.size) {
        this.byProvider.delete(providerId);
      }
      changed = Boolean(this.commit(providerId, now, [], removed)) || changed;
    }
    return changed;
  }

  clear(): void {
    this.byProvider.clear();
  }

  private commit(
    providerId: string,
    at: number,
    upserted: string[],
    removed: string[],
  ): ResourceStoreChange | null {
    if (!upserted.length && !removed.length) {
      return null;
    }
    this.currentRevision += 1;
    const change: ResourceStoreChange = {
      providerId,
      revision: this.currentRevision,
      upserted,
      removed,
      at,
    };
    return change;
  }
}
