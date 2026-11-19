import path from 'node:path';

import type { SystemStateSnapshot } from '../system/types';
import type { ProviderRegistry } from '../tools/provider-registry';
import type {
  ResourceDescriptor,
  ResourceKind,
  UserContextSnapshot,
  WindowContext,
} from './types';

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

const processName = (value: string): string =>
  normalize(path.basename(value).replace(/\.exe$/i, ''));

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const applicationId = (source: string, id: string): string =>
  `application:${source}:${id}`;

const windowId = (window: WindowContext): string =>
  `window:${window.pid}:${window.handle ?? normalize(window.title)}`;

const windowMatches = (
  left: WindowContext | null,
  right: WindowContext,
): boolean => {
  if (!left) {
    return false;
  }
  if (left.handle && right.handle) {
    return left.handle === right.handle;
  }
  return left.pid === right.pid && left.title === right.title;
};

const providerMatchesWindow = (
  provider: ReturnType<ProviderRegistry['list']>[number],
  window: {
    process: string;
    title: string;
  },
): boolean => {
  const process = normalize(window.process);
  const title = normalize(window.title);
  const targets = [
    ...(provider.manifest.activation?.processes || []),
    ...(provider.manifest.activation?.applications || []),
    ...(provider.manifest.requirements?.applications || []),
  ]
    .map(normalize)
    .filter(Boolean);
  return targets.some(
    (target) => process.includes(target) || title.includes(target),
  );
};

const baseCapabilities = (kind: ResourceKind): string[] => {
  if (kind === 'application') {
    return [
      'software.launch',
      'window.focus',
      'screen.capture',
      'screen.ocr',
      'ui.inspect',
      'ui.action',
    ];
  }
  if (kind === 'window') {
    return [
      'window.focus',
      'screen.capture',
      'screen.ocr',
      'ui.inspect',
      'ui.action',
    ];
  }
  return [];
};

export class ResourceCatalog {
  constructor(private readonly providers?: ProviderRegistry) {}

  build(
    system: SystemStateSnapshot | null,
    user: UserContextSnapshot,
    now = Date.now(),
    additional: ResourceDescriptor[] = [],
  ): ResourceDescriptor[] {
    if (!system?.capturedAt) {
      return additional;
    }

    const providers = this.providers?.list() || [];
    const resources: ResourceDescriptor[] = system.installedApplications.map(
      (application) => {
        const steamMatch =
          application.source === 'steam'
            ? application.id.match(/^steam-(.+)$/i)
            : null;
        const providerIds = providers
          .filter((provider) =>
            (provider.manifest.requirements?.applications || []).some(
              (required) =>
                normalize(application.name).includes(normalize(required)),
            ),
          )
          .map((provider) => provider.manifest.id);
        const capabilities = [
          ...baseCapabilities('application'),
          ...providers
            .filter((provider) => providerIds.includes(provider.manifest.id))
            .flatMap((provider) => provider.toolIds),
        ];
        if (steamMatch) {
          capabilities.push('steam.launch_game');
        }
        return {
          id: applicationId(application.source, application.id),
          kind: 'application' as const,
          name: application.name,
          aliases: unique([
            normalize(application.name),
            application.executable ? processName(application.executable) : '',
          ]).filter(Boolean),
          source: application.source,
          active: false,
          health: 'available' as const,
          providerIds,
          capabilities: unique(capabilities),
          updatedAt: system.capturedAt,
          metadata: {
            version: application.version || null,
            publisher: application.publisher || null,
            executable: application.executable || null,
            launchTarget: application.launchTarget || null,
            installLocation: application.installLocation || null,
            steamAppId: steamMatch?.[1] || null,
          },
        };
      },
    );

    const windows = system.windows.map((window) => {
      const providerIds = providers
        .filter((provider) => providerMatchesWindow(provider, window))
        .map((provider) => provider.manifest.id);
      return {
        id: windowId(window),
        kind: 'window' as const,
        name: window.title || window.process,
        aliases: unique([
          normalize(window.title),
          normalize(window.process),
        ]).filter(Boolean),
        source: 'system.window',
        active:
          window.focused === true ||
          windowMatches(user.activeWindow?.value || null, window),
        health: 'available' as const,
        providerIds,
        capabilities: baseCapabilities('window'),
        updatedAt: system.capturedAt,
        metadata: {
          pid: window.pid,
          process: window.process,
          focused: window.focused === true,
        },
      };
    });
    const recentFiles = system.recentFiles.map((file) => ({
      id: `file:${process.platform === 'win32' ? file.path.toLowerCase() : file.path}`,
      kind: 'file' as const,
      name: file.name || path.basename(file.path),
      aliases: [normalize(file.name), normalize(file.path)].filter(Boolean),
      source: 'system.recent',
      active: false,
      health: 'available' as const,
      providerIds: ['filesystem'],
      capabilities: [
        'fs.get_info',
        'fs.open',
        'fs.read_file',
        'fs.write_file',
        'fs.hash',
      ],
      updatedAt: file.lastUsedAt || system.capturedAt,
      metadata: {
        path: file.path,
        lastUsedAt: file.lastUsedAt,
      },
    }));

    const activeWindow = user.activeWindow?.value || null;
    const activeApplicationId = user.activeApplication?.value || null;
    let activeApplication = resources.find(
      (resource) => resource.id === activeApplicationId,
    );

    if (!activeApplication && activeWindow) {
      activeApplication =
        this.matchApplicationForWindow(resources, activeWindow) || undefined;
      if (!activeApplication) {
        const id = `application:process:${activeWindow.process}`;
        activeApplication = {
          id,
          kind: 'application',
          name: activeWindow.process,
          aliases: unique([
            normalize(activeWindow.process),
            normalize(activeWindow.title),
          ]).filter(Boolean),
          source: 'process',
          active: true,
          health: 'unknown',
          providerIds: [],
          capabilities: baseCapabilities('application'),
          updatedAt: now,
          metadata: {
            pid: activeWindow.pid,
            runtimeOnly: true,
          },
        };
        resources.push(activeApplication);
      }
    }

    const activeIds = new Set<string>();
    if (activeApplication) {
      activeIds.add(activeApplication.id);
    }
    const activeWindowResource = windows.find((window) => window.active);
    if (activeWindowResource) {
      activeIds.add(activeWindowResource.id);
    }

    const recentIds = new Set(user.recentResourceIds);
    for (const resource of resources) {
      resource.active = activeIds.has(resource.id);
      if (recentIds.has(resource.id) && resource.health === 'available') {
        resource.health = 'available';
      }
    }

    const allResources = [...resources, ...windows, ...recentFiles];
    const knownIds = new Set(allResources.map((resource) => resource.id));
    for (const resource of additional) {
      if (!knownIds.has(resource.id)) {
        allResources.push(resource);
        knownIds.add(resource.id);
      }
    }
    return allResources.sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(recentIds.has(right.id)) - Number(recentIds.has(left.id)) ||
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name),
    );
  }

  search(
    resources: ResourceDescriptor[],
    query: string,
    options: {
      kind?: ResourceKind;
      activeOnly?: boolean;
      limit?: number;
    } = {},
  ): ResourceDescriptor[] {
    const needle = normalize(query);
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    return resources
      .filter((resource) => !options.kind || resource.kind === options.kind)
      .filter((resource) => !options.activeOnly || resource.active)
      .map((resource) => {
        const name = normalize(resource.name);
        const aliases = resource.aliases.map(normalize);
        let score = resource.active ? 10 : 0;
        if (!needle) {
          score += 1;
        } else if (name === needle || aliases.includes(needle)) {
          score += 100;
        } else if (name.startsWith(needle)) {
          score += 80;
        } else if (name.includes(needle)) {
          score += 60;
        } else if (aliases.some((alias) => alias.includes(needle))) {
          score += 40;
        }
        return { resource, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.resource.name.localeCompare(right.resource.name),
      )
      .slice(0, limit)
      .map((entry) => entry.resource);
  }

  private matchApplicationForWindow(
    resources: ResourceDescriptor[],
    window: WindowContext,
  ): ResourceDescriptor | null {
    const process = processName(window.process);
    const title = normalize(window.title);
    return (
      resources.find((resource) => {
        if (resource.kind !== 'application') {
          return false;
        }
        const executable =
          typeof resource.metadata.executable === 'string'
            ? processName(resource.metadata.executable)
            : '';
        return (
          (process &&
            (executable === process || resource.aliases.includes(process))) ||
          (title &&
            normalize(resource.name) &&
            title.includes(normalize(resource.name)))
        );
      }) || null
    );
  }
}
