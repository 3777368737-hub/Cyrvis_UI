import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFastToolMatrix, type FastToolMatrix } from '../tools/matrix';
import type { DesktopHost, WindowInfo } from '../tools/types';
import {
  BrowserPerceptionProvider,
  createBuiltinProviderBundle,
} from './index';

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dynamic perception integration', () => {
  it('refreshes browser tabs, binds close_tab, and verifies removal', async () => {
    vi.stubEnv('CYRVIS_BROWSER_DEBUG_URL', 'http://127.0.0.1:9222');
    const edgeWindow: WindowInfo = {
      pid: 42,
      process: 'msedge',
      title: 'Project Docs - Microsoft Edge',
      focused: true,
    };
    const desktop = {
      listWindows: async () => [edgeWindow],
      getForegroundWindow: async () => edgeWindow,
    } as unknown as DesktopHost;
    let tabs = [
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
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/json/list')) {
        return new Response(JSON.stringify(tabs), { status: 200 });
      }
      if (url.includes('/json/close/tab-docs')) {
        tabs = tabs.filter((tab) => tab.id !== 'tab-docs');
        return new Response('Target is closing', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const provider = new BrowserPerceptionProvider({
      fetch: fetchMock,
      intervalMs: 60_000,
      ttlMs: 120_000,
    });
    const builtinProviders = createBuiltinProviderBundle({
      fetch: fetchMock,
    });
    let matrix: FastToolMatrix | null = null;

    try {
      matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
        builtinProviders,
        perceptionProviders: [provider],
      });
      matrix.dynamicContext.user.setActiveWindow(edgeWindow);
      await matrix.dynamicContext.refreshPerception('browser-debug');
      await waitFor(() =>
        matrix!.dynamicContext
          .getSnapshot()
          .resources.some((resource) => resource.kind === 'tab'),
      );

      const snapshot = matrix.dynamicContext.getSnapshot();
      const docsTab = snapshot.resources.find(
        (resource) => resource.metadata.tabId === 'tab-docs',
      );
      const closeBinding = snapshot.bindings.find(
        (binding) =>
          binding.resourceId === docsTab?.id &&
          binding.capabilityId === 'browser.close_tab',
      );

      expect(docsTab).toMatchObject({
        kind: 'tab',
        active: true,
        providerIds: ['browser-debug'],
      });
      expect(closeBinding).toMatchObject({
        active: true,
        defaultArgs: { tabId: 'tab-docs' },
      });
      expect(matrix.surface.isVisible('browser.list_tabs')).toBe(true);
      expect(matrix.surface.isVisible('browser.close_tab')).toBe(true);
      expect(matrix.dynamicContext.getContext()).toContain(
        'tab-docs: Project Docs',
      );
      const resourceQuery = await matrix.registry.execute('context.resources', {
        query: 'Project Docs',
        kind: 'tab',
      });
      expect(resourceQuery.data).toMatchObject({
        resources: [
          expect.objectContaining({
            id: docsTab?.id,
            kind: 'tab',
          }),
        ],
      });

      const execution = await matrix.dynamicContext.executeBinding(
        docsTab!.id,
        'browser.close_tab',
        {},
        { confirmed: true },
      );

      expect(execution.result.ok).toBe(true);
      expect(execution.verification).toMatchObject({
        ok: true,
        kind: 'tool_result',
      });
      await waitFor(
        () =>
          !matrix!.dynamicContext
            .getSnapshot()
            .resources.some(
              (resource) => resource.metadata.tabId === 'tab-docs',
            ),
      );
      expect(
        matrix.dynamicContext
          .getSnapshot()
          .resources.some((resource) => resource.metadata.tabId === 'tab-docs'),
      ).toBe(false);
      expect(
        matrix.dynamicContext
          .getSnapshot()
          .resources.some((resource) => resource.metadata.tabId === 'tab-mail'),
      ).toBe(true);
    } finally {
      matrix?.dispose();
    }
  });

  it('hides provider tools when dynamic perception has no usable state', async () => {
    vi.stubEnv('CYRVIS_BROWSER_DEBUG_URL', 'http://127.0.0.1:9222');
    const fetchMock = vi.fn(async () => {
      throw new Error('debug endpoint unavailable');
    }) as unknown as typeof fetch;
    const provider = new BrowserPerceptionProvider({
      fetch: fetchMock,
      intervalMs: 60_000,
      ttlMs: 120_000,
    });
    const matrix = createFastToolMatrix(
      {
        listWindows: async () => [],
        getForegroundWindow: async () => null,
      } as unknown as DesktopHost,
      process.cwd(),
      undefined,
      {
        builtinProviders: createBuiltinProviderBundle({ fetch: fetchMock }),
        perceptionProviders: [provider],
      },
    );

    try {
      await matrix.dynamicContext.refreshPerception('browser-debug');
      await waitFor(
        () =>
          matrix.dynamicContext.getPerceptionStatuses()[0]?.state ===
          'degraded',
      );
      expect(matrix.surface.isVisible('browser.list_tabs')).toBe(false);
      expect(matrix.capabilityCatalog.get('browser.list_tabs')).toMatchObject({
        availability: 'unavailable',
      });
    } finally {
      matrix.dispose();
    }
  });
});
