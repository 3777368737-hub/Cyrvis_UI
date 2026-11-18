/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

import type { SystemStateStore } from '../system/system-state';
import { createSystemStateTools } from '../system/tools';
import { CapabilityBroker } from './capability-broker';
import { CapabilityCatalog } from './capability-catalog';
import { createCapabilityTools } from './capability-tools';
import { DESKTOP_TOOLS } from './desktop-tools';
import { LocalDesktopHost } from './desktop-host';
import { FILESYSTEM_TOOLS } from './filesystem';
import { OFFICE_TOOLS } from './office-tools';
import { PathPolicy } from './path-policy';
import { ProviderManager } from './provider-manager';
import { ProviderRegistry } from './provider-registry';
import { ToolRegistry } from './registry';
import { FastToolRouter } from './router';
import {
  createDynamicFastToolProviderCatalog,
  type FastToolProviderCatalog,
} from './llm-tools';
import { ToolSurface } from './tool-surface';
import { ToolUsageStore } from './tool-usage';
import type { DesktopHost, ToolContext, ToolPermission } from './types';

export interface FastToolMatrix {
  context: ToolContext;
  registry: ToolRegistry;
  router: FastToolRouter;
  providerCatalog: FastToolProviderCatalog;
  capabilityCatalog: CapabilityCatalog;
  capabilityBroker: CapabilityBroker;
  surface: ToolSurface;
  providerRegistry: ProviderRegistry;
  providerManager: ProviderManager;
  usage: ToolUsageStore;
  dispose(): void;
}

export interface FastToolMatrixOptions {
  maxVisibleTools?: number;
  activationTtlMs?: number;
  manifestDirectories?: string[];
  providerPublicKeyPem?: string;
  allowUntrustedProviders?: boolean;
  deniedPermissions?: ToolPermission[];
  usageStateFile?: string;
  usageAuditFile?: string;
}

export const createFastToolContext = (
  desktop: DesktopHost = new LocalDesktopHost(),
  cwd = process.cwd(),
): { context: ToolContext; pathPolicy: PathPolicy } => {
  const homeDirectory = os.homedir();
  const pathPolicy = new PathPolicy(cwd, homeDirectory);
  return {
    pathPolicy,
    context: {
      cwd,
      homeDirectory,
      platform: process.platform,
      desktop,
      resolvePath: (input) => pathPolicy.resolve(input, homeDirectory),
    },
  };
};

export const createFastToolMatrix = (
  desktop: DesktopHost = new LocalDesktopHost(),
  cwd = process.cwd(),
  systemState?: SystemStateStore,
  options: FastToolMatrixOptions = {},
): FastToolMatrix => {
  const { context, pathPolicy } = createFastToolContext(desktop, cwd);
  const usage = new ToolUsageStore({
    stateFile: options.usageStateFile,
    auditFile: options.usageAuditFile,
  });
  const registry = new ToolRegistry(context, pathPolicy, usage);
  registry.registerAll([
    ...FILESYSTEM_TOOLS,
    ...DESKTOP_TOOLS,
    ...OFFICE_TOOLS,
    ...(systemState ? createSystemStateTools(systemState) : []),
  ]);
  const providerRegistry = new ProviderRegistry();
  const capabilityCatalog = new CapabilityCatalog(
    registry,
    systemState,
    providerRegistry,
    options.deniedPermissions,
  );
  const surface = new ToolSurface(registry, capabilityCatalog, options);
  const capabilityBroker = new CapabilityBroker(
    registry,
    capabilityCatalog,
    surface,
  );
  registry.registerAll(
    createCapabilityTools(capabilityBroker, providerRegistry),
    'capability',
  );
  surface.refresh();
  const unsubscribeRegistry = registry.subscribe(() => surface.refresh());
  const unsubscribeProviders = providerRegistry.subscribe(() => {
    surface.refresh();
  });
  const providerManager = new ProviderManager(
    registry,
    providerRegistry,
    systemState,
    {
      manifestDirectories: options.manifestDirectories,
      publicKeyPem: options.providerPublicKeyPem,
      allowUntrusted: options.allowUntrustedProviders,
      deniedPermissions: options.deniedPermissions,
    },
  );
  const providerCatalog = createDynamicFastToolProviderCatalog(
    registry,
    surface,
  );
  const router = new FastToolRouter(registry, context, {
    providerCatalog,
    capabilityBroker,
  });
  const unsubscribeState = systemState?.onChange(() => surface.refresh());
  return {
    context,
    registry,
    router,
    providerCatalog,
    capabilityCatalog,
    capabilityBroker,
    surface,
    providerRegistry,
    providerManager,
    usage,
    dispose: () => {
      void providerManager.stop();
      surface.dispose();
      unsubscribeRegistry();
      unsubscribeProviders();
      unsubscribeState?.();
    },
  };
};
