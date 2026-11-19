import { listBrowserTabs, type BrowserCdpOptions } from '../browser-cdp';
import type { ResourceDescriptor } from '../types';
import type { PerceptionContext, PerceptionProvider } from './types';

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const browserProcess = (value: string): boolean =>
  /(?:chrome|msedge|brave|vivaldi|opera)/i.test(value);

const sanitizeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = '';
    // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.slice(0, 2_048);
  }
};

const activeTabId = (
  tabs: Array<{ id: string; title: string; url: string }>,
  activeWindowTitle: string,
): string | null => {
  const windowTitle = normalize(activeWindowTitle);
  if (!windowTitle) {
    return null;
  }
  const matches = tabs.filter((tab) => {
    const title = normalize(tab.title);
    if (title.length >= 3 && windowTitle.includes(title)) {
      return true;
    }
    try {
      const host = normalize(new URL(tab.url).hostname);
      return host.length >= 3 && windowTitle.includes(host);
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0]?.id || null : null;
};

const resourceForTab = (
  providerId: string,
  tab: { id: string; title: string; url: string; windowId?: number },
  active: boolean,
): ResourceDescriptor => {
  let host = '';
  const safeUrl = sanitizeUrl(tab.url);
  const title = (tab.title || tab.url).slice(0, 256);
  try {
    host = new URL(safeUrl).hostname;
  } catch {
    // Keep malformed URLs as non-indexed resources.
  }
  return {
    id: `tab:${providerId}:${tab.id}`,
    kind: 'tab',
    name: title,
    aliases: [
      normalize(title),
      normalize(host),
      normalize(safeUrl),
      normalize(tab.id),
    ].filter(Boolean),
    source: `perception:${providerId}`,
    active,
    health: 'available',
    providerIds: [providerId],
    capabilities: ['browser.activate_tab', 'browser.close_tab'],
    updatedAt: Date.now(),
    sensitivity: 'private',
    metadata: {
      tabId: tab.id,
      url: safeUrl,
      host,
      browserWindowId: tab.windowId ?? null,
    },
  };
};

export interface BrowserPerceptionProviderOptions extends BrowserCdpOptions {
  id?: string;
  intervalMs?: number;
  ttlMs?: number;
  timeoutMs?: number;
}

export class BrowserPerceptionProvider implements PerceptionProvider {
  readonly id: string;
  readonly intervalMs: number;
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly triggerToolIds = [
    'browser.open_tab',
    'browser.activate_tab',
    'browser.close_tab',
  ];

  constructor(private readonly options: BrowserPerceptionProviderOptions = {}) {
    this.id = options.id || 'browser-debug';
    this.intervalMs = Math.max(
      500,
      Number.isFinite(options.intervalMs) ? Number(options.intervalMs) : 2_000,
    );
    this.ttlMs = Math.max(
      this.intervalMs * 2,
      Number.isFinite(options.ttlMs)
        ? Number(options.ttlMs)
        : this.intervalMs * 3,
    );
    this.timeoutMs = Math.max(
      500,
      Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 4_000,
    );
  }

  async refresh(
    context: PerceptionContext,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]> {
    const tabs = await listBrowserTabs(
      {
        fetch: this.options.fetch,
        baseUrl: this.options.baseUrl,
        timeoutMs: this.timeoutMs,
      },
      signal,
    );
    const activeWindow = context.user.activeWindow?.value || null;
    const hasActiveBrowser =
      activeWindow !== null && browserProcess(activeWindow.process);
    const currentTabId = hasActiveBrowser
      ? activeTabId(tabs, activeWindow.title)
      : null;
    return tabs.map((tab) =>
      resourceForTab(this.id, tab, tab.id === currentTabId),
    );
  }
}
