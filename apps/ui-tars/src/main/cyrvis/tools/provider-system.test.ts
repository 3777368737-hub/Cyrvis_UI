/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SystemStateStore } from '../system/system-state';
import type { SteamGame } from '../system/types';
import { createFastToolMatrix } from './matrix';
import {
  parseProviderManifest,
  providerManifestPayload,
} from './provider-manifest';
import type { ProviderManifest } from './provider-types';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  ToolDefinition,
  WindowInfo,
} from './types';

const noBuiltinProviders = { tools: [], manifests: [] };

class ProviderTestDesktop implements DesktopHost {
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
    return [];
  }
  async listWindows(): Promise<WindowInfo[]> {
    return [];
  }
  async controlWindow(query: string): Promise<string> {
    return query;
  }
  async minimizeAllWindows(): Promise<number> {
    return 0;
  }
  async restoreAllWindows(): Promise<number> {
    return 0;
  }
  async createPresentation(): Promise<void> {
    return undefined;
  }
  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: process.platform,
      release: 'test',
      architecture: 'x64',
      hostname: 'test',
      homeDirectory: os.homedir(),
      cpuCount: 1,
      totalMemoryBytes: 1,
      freeMemoryBytes: 1,
      uptimeSeconds: 1,
    };
  }
  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 1, freeBytes: 1 };
  }
}

const createStateStore = async (
  desktop: DesktopHost,
  games: SteamGame[],
): Promise<SystemStateStore> => {
  const store = new SystemStateStore(desktop, {
    staleMs: 60_000,
    discoverers: {
      applications: async () => [],
      steam: async () => ({ root: games.length ? 'C:\\Steam' : null, games }),
      disks: async () => [],
      battery: async () => null,
      services: async () => [],
      recentFiles: async () => [],
    },
  });
  await store.refresh(true);
  return store;
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
};

describe('provider system', () => {
  it('verifies signed trusted manifests and rejects untrusted ones by default', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const base: ProviderManifest = {
      schemaVersion: 1,
      toolApiVersion: 1,
      id: 'signed-provider',
      name: 'Signed Provider',
      version: '1.0.0',
      trust: 'trusted',
      permissions: ['remote.tools'],
      transport: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
      },
      tools: [{ remoteName: 'echo' }],
    };
    const signature = crypto
      .sign(null, Buffer.from(providerManifestPayload(base)), privateKey)
      .toString('base64');

    expect(() =>
      parseProviderManifest({ ...base, signature: `ed25519:${signature}` }),
    ).toThrow(/trusted providers require/);
    expect(
      parseProviderManifest(
        { ...base, signature: `ed25519:${signature}` },
        {
          publicKeyPem: publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
      ).id,
    ).toBe('signed-provider');
  });

  it('loads a manifest and gates builtin tools by live system state', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cyrvis-provider-manifests-'),
    );
    const desktop = new ProviderTestDesktop();
    const games: SteamGame[] = [];
    const store = await createStateStore(desktop, games);
    await fs.writeFile(
      path.join(directory, 'steam-provider.json'),
      JSON.stringify({
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'steam',
        name: 'Steam Provider',
        version: '1.0.0',
        trust: 'untrusted',
        transport: {
          type: 'builtin',
          toolIds: ['steam.list_games', 'steam.launch_game'],
        },
        requirements: { steamGamesMin: 1 },
      }),
      'utf8',
    );
    const matrix = createFastToolMatrix(desktop, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
      manifestDirectories: [directory],
      allowUntrustedProviders: true,
    });

    try {
      await matrix.providerManager.start();
      expect(matrix.capabilityCatalog.get('steam.launch_game')).toMatchObject({
        availability: 'unavailable',
      });
      expect(matrix.providerManager.list()[0]?.availability).toBe(
        'unavailable',
      );

      games.push({
        appId: '570',
        name: 'Dota 2',
        installDirectory: 'C:\\Steam\\dota 2 beta',
        libraryPath: 'C:\\Steam\\steamapps',
      });
      await store.refresh(true);
      await waitFor(
        () => matrix.providerManager.list()[0]?.availability === 'available',
      );
      expect(matrix.capabilityCatalog.get('steam.launch_game')).toMatchObject({
        availability: 'available',
      });

      const manifestPath = path.join(directory, 'steam-provider.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          toolApiVersion: 1,
          id: 'steam',
          name: 'Steam Provider',
          version: '1.0.1',
          trust: 'untrusted',
          transport: {
            type: 'builtin',
            toolIds: ['steam.list_games', 'steam.launch_game'],
          },
          requirements: { steamGamesMin: 1 },
        }),
        'utf8',
      );
      await matrix.providerManager.reload();
      expect(matrix.providerManager.list()[0]?.manifest.version).toBe('1.0.1');

      await fs.rm(manifestPath);
      await matrix.providerManager.reload();
      expect(matrix.providerManager.list()).toHaveLength(0);
    } finally {
      matrix.dispose();
      store.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('loads and executes an isolated stdio MCP provider from a manifest', async () => {
    await fs.mkdir(path.join(process.cwd(), '.tmp'), { recursive: true });
    const root = await fs.mkdtemp(
      path.join(process.cwd(), '.tmp', 'cyrvis-mcp-provider-'),
    );
    const serverFile = path.join(root, 'server.cjs');
    await fs.writeFile(
      serverFile,
      `
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const server = new Server(
  { name: 'cyrvis-test-provider', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{
    type: 'text',
    text: 'echo:' + String(request.params.arguments.text || ''),
  }],
}));
server.connect(new StdioServerTransport());
`,
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'provider.json'),
      JSON.stringify({
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'local-echo',
        name: 'Local Echo Provider',
        version: '1.0.0',
        trust: 'untrusted',
        permissions: ['process.spawn', 'remote.tools'],
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [serverFile],
          cwd: process.cwd(),
        },
        tools: [
          {
            remoteName: 'echo',
            domain: 'system',
            risk: 'low',
            tier: 1,
            activation: 'always',
            permissions: ['process.spawn', 'remote.tools'],
          },
        ],
      }),
      'utf8',
    );
    const desktop = new ProviderTestDesktop();
    const matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
      builtinProviders: noBuiltinProviders,
      manifestDirectories: [root],
      allowUntrustedProviders: true,
    });

    try {
      await matrix.providerManager.start();
      await waitFor(
        () => Boolean(matrix.registry.get('local-echo.echo')),
        5000,
      );
      const result = await matrix.registry.execute('local-echo.echo', {
        text: 'hello',
      });
      expect(result).toMatchObject({
        ok: true,
        speech: 'echo:hello',
      });
      expect(matrix.providerManager.list()[0]).toMatchObject({
        availability: 'available',
        toolIds: ['local-echo.echo'],
      });
    } finally {
      await matrix.providerManager.stop();
      matrix.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps external provider tools discoverable while the provider is unavailable', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cyrvis-inactive-provider-'),
    );
    await fs.writeFile(
      path.join(directory, 'inactive-provider.json'),
      JSON.stringify({
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'inactive-provider',
        name: 'Inactive Provider',
        version: '1.0.0',
        trust: 'untrusted',
        permissions: ['remote.tools'],
        requirements: {
          applications: ['Application That Is Not Installed'],
        },
        transport: {
          type: 'streamable-http',
          url: 'https://example.invalid/mcp',
        },
        tools: [
          {
            remoteName: 'echo',
            domain: 'network',
            risk: 'low',
            tier: 2,
            activation: 'state',
          },
        ],
      }),
      'utf8',
    );
    const desktop = new ProviderTestDesktop();
    const store = await createStateStore(desktop, []);
    const matrix = createFastToolMatrix(desktop, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
      manifestDirectories: [directory],
      allowUntrustedProviders: true,
    });

    try {
      await matrix.providerManager.start();
      expect(matrix.registry.get('inactive-provider.echo')).toBeDefined();
      expect(
        matrix.capabilityCatalog.get('inactive-provider.echo'),
      ).toMatchObject({
        availability: 'unavailable',
      });
      expect(
        matrix.capabilityBroker.search('echo').map((entry) => entry.id),
      ).toContain('inactive-provider.echo');
      const providerList = await matrix.registry.execute(
        'capability.providers',
        {},
      );
      expect(providerList.ok).toBe(true);
      expect(JSON.stringify(providerList.data)).not.toContain('headers');
      expect(JSON.stringify(providerList.data)).toContain(
        'Application That Is Not Installed',
      );
    } finally {
      await matrix.providerManager.stop();
      matrix.dispose();
      store.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('defers foreground-scoped providers until their application is active', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cyrvis-foreground-provider-'),
    );
    await fs.writeFile(
      path.join(directory, 'foreground-provider.json'),
      JSON.stringify({
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'foreground-provider',
        name: 'Foreground Provider',
        version: '1.0.0',
        trust: 'untrusted',
        permissions: ['remote.tools'],
        activation: {
          mode: 'foreground',
          applications: ['Visual Studio Code'],
          processes: ['Code'],
        },
        transport: {
          type: 'streamable-http',
          url: 'https://example.invalid/mcp',
        },
        tools: [
          {
            remoteName: 'echo',
            domain: 'system',
            risk: 'low',
            tier: 2,
            activation: 'on-demand',
          },
        ],
      }),
      'utf8',
    );
    const desktop = new ProviderTestDesktop();
    const store = await createStateStore(desktop, []);
    const matrix = createFastToolMatrix(desktop, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
      manifestDirectories: [directory],
      allowUntrustedProviders: true,
    });

    try {
      await matrix.providerManager.start();
      expect(matrix.registry.get('foreground-provider.echo')).toBeDefined();
      expect(matrix.providerManager.list()[0]).toMatchObject({
        availability: 'unknown',
        unavailableReason: 'Provider 正在等待匹配的前台应用。',
      });
      expect(
        matrix.capabilityCatalog.get('foreground-provider.echo'),
      ).toMatchObject({
        availability: 'unknown',
      });
    } finally {
      await matrix.providerManager.stop();
      matrix.dispose();
      store.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('tracks usage and rejects unsupported tool schema versions', async () => {
    const usageFile = path.join(
      os.tmpdir(),
      `cyrvis-usage-${Date.now()}-${Math.random()}.json`,
    );
    const desktop = new ProviderTestDesktop();
    const matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
      builtinProviders: noBuiltinProviders,
      usageStateFile: usageFile,
    });

    try {
      await matrix.registry.execute('app.launch', { name: 'notepad' });
      expect(matrix.registry.getUsage('app.launch')).toMatchObject({
        successes: 1,
        failures: 0,
      });
      await waitFor(async () => {
        try {
          return (await fs.readFile(usageFile, 'utf8')).includes('app.launch');
        } catch {
          return false;
        }
      });

      const incompatible: ToolDefinition = {
        name: 'test.future',
        domain: 'system',
        description: 'Future schema.',
        risk: 'low',
        capability: { schemaVersion: 2 },
        inputSchema: {
          type: 'object',
          properties: {},
        },
        prepare: () => ({}),
        async execute() {
          return { ok: true, tool: 'test.future', speech: 'future' };
        },
      };
      expect(() => matrix.registry.register(incompatible)).toThrow(
        /unsupported schema version/,
      );
    } finally {
      matrix.dispose();
      await fs.rm(usageFile, { force: true });
    }
  });

  it('removes capabilities whose permissions are denied by policy', () => {
    const desktop = new ProviderTestDesktop();
    const matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
      builtinProviders: noBuiltinProviders,
      deniedPermissions: ['filesystem.write'],
    });
    try {
      expect(matrix.capabilityCatalog.get('fs.read_file')).toMatchObject({
        availability: 'available',
      });
      expect(matrix.capabilityCatalog.get('fs.write_file')).toMatchObject({
        availability: 'unavailable',
      });
    } finally {
      matrix.dispose();
    }
  });
});
