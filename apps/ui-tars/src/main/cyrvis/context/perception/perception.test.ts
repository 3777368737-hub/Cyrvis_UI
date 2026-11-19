import { describe, expect, it, vi } from 'vitest';

import { UserContextStore } from '../user-context';
import type { ResourceDescriptor } from '../types';
import { BrowserPerceptionProvider } from './browser-provider';
import { IncrementalResourceStore } from './resource-store';
import { PerceptionScheduler } from './scheduler';
import type { PerceptionProvider } from './types';

const resource = (
  id: string,
  name: string,
  metadata: ResourceDescriptor['metadata'] = {},
): ResourceDescriptor => ({
  id,
  kind: 'tab',
  name,
  aliases: [],
  source: 'test',
  active: false,
  health: 'available',
  providerIds: ['test-provider'],
  capabilities: ['browser.close_tab'],
  updatedAt: 0,
  metadata,
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
};

describe('IncrementalResourceStore', () => {
  it('applies upserts, removals, unchanged refreshes, and TTL expiry', () => {
    const store = new IncrementalResourceStore();

    expect(
      store.replaceProvider('browser', [resource('tab-1', 'Docs')], {
        observedAt: 1_000,
        ttlMs: 5_000,
      }),
    ).toMatchObject({
      upserted: ['tab-1'],
      removed: [],
    });
    expect(
      store.replaceProvider('browser', [resource('tab-1', 'Docs')], {
        observedAt: 1_500,
        ttlMs: 5_000,
      }),
    ).toBeNull();
    expect(store.list(1_600)[0]).toMatchObject({
      id: 'tab-1',
      lastSeenAt: 1_500,
    });

    expect(
      store.replaceProvider('browser', [resource('tab-1', 'Updated')], {
        observedAt: 2_000,
        ttlMs: 5_000,
      }),
    ).toMatchObject({
      upserted: ['tab-1'],
    });
    expect(
      store.replaceProvider('browser', [], {
        observedAt: 2_100,
        ttlMs: 5_000,
      }),
    ).toMatchObject({
      removed: ['tab-1'],
    });
    expect(store.list(2_200)).toEqual([]);

    store.replaceProvider('browser', [resource('tab-2', 'Temporary')], {
      observedAt: 3_000,
      ttlMs: 500,
    });
    expect(store.prune(3_501)).toBe(true);
    expect(store.list(3_502)).toEqual([]);
  });
});

describe('BrowserPerceptionProvider', () => {
  it('turns DevTools page targets into tab resources and marks the active tab', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 'tab-docs',
              title: 'Project Docs',
              url: 'https://docs.example.com/guide',
              type: 'page',
            },
            {
              id: 'tab-mail',
              title: 'Inbox',
              url: 'https://mail.example.com',
              type: 'page',
            },
            {
              id: 'worker',
              title: 'Service Worker',
              url: 'https://docs.example.com',
              type: 'service_worker',
            },
          ]),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const provider = new BrowserPerceptionProvider({ fetch: fetchMock });
    const user = new UserContextStore();
    user.setActiveWindow({
      pid: 42,
      process: 'msedge',
      title: 'Project Docs - Microsoft Edge',
    });

    const resources = await provider.refresh(
      {
        now: Date.now(),
        system: null,
        user: user.getSnapshot(),
      },
      new AbortController().signal,
    );

    expect(resources).toHaveLength(2);
    expect(
      resources.find((entry) => entry.metadata.tabId === 'tab-docs'),
    ).toMatchObject({
      kind: 'tab',
      active: true,
      capabilities: ['browser.activate_tab', 'browser.close_tab'],
      metadata: {
        tabId: 'tab-docs',
        url: 'https://docs.example.com/guide',
        host: 'docs.example.com',
      },
    });
    expect(
      resources.find((entry) => entry.metadata.tabId === 'tab-mail'),
    ).toMatchObject({
      active: false,
    });
  });
});

describe('PerceptionScheduler', () => {
  it('stores successful refreshes and marks failed providers degraded', async () => {
    let fail = false;
    const provider: PerceptionProvider = {
      id: 'test-perception',
      intervalMs: 60_000,
      ttlMs: 120_000,
      async refresh() {
        if (fail) {
          throw new Error('probe unavailable');
        }
        return [resource('tab-1', 'Docs')];
      },
    };
    const resources = new IncrementalResourceStore();
    const user = new UserContextStore();
    const scheduler = new PerceptionScheduler({
      providers: [],
      resources,
      context: () => ({
        now: Date.now(),
        system: null,
        user: user.getSnapshot(),
      }),
      minIntervalMs: 250,
    });

    try {
      scheduler.start();
      scheduler.registerProvider(provider);
      await waitFor(() => scheduler.listStatuses()[0]?.state === 'healthy');
      expect(resources.list()).toHaveLength(1);

      fail = true;
      await scheduler.refreshProvider(provider.id);
      expect(scheduler.listStatuses()[0]).toMatchObject({
        state: 'degraded',
        consecutiveFailures: 1,
        error: 'probe unavailable',
      });
      expect(resources.list()).toHaveLength(1);

      scheduler.unregisterProvider(provider.id);
      expect(scheduler.listStatuses()).toEqual([]);
      expect(resources.list()).toEqual([]);
    } finally {
      scheduler.stop();
    }
  });
});
