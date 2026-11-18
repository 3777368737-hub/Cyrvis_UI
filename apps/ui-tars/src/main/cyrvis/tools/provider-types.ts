/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CapabilityRequirements,
  CapabilityAvailability,
  ToolDomain,
  ToolExposureTier,
  ToolPermission,
  ToolRisk,
} from './types';

export const TOOL_API_VERSION = 1;
export const PROVIDER_MANIFEST_SCHEMA_VERSION = 1;

export type ProviderTrust = 'builtin' | 'trusted' | 'untrusted';

export interface ProviderManifestTransportBuiltin {
  type: 'builtin';
  toolIds?: string[];
}

export interface ProviderManifestTransportStdio {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProviderManifestTransportHttp {
  type: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type ProviderManifestTransport =
  | ProviderManifestTransportBuiltin
  | ProviderManifestTransportStdio
  | ProviderManifestTransportHttp;

export interface RemoteToolPolicy {
  remoteName: string;
  domain?: ToolDomain;
  risk?: ToolRisk;
  tier?: ToolExposureTier;
  activation?: 'always' | 'state' | 'on-demand';
  priority?: number;
  tags?: string[];
  permissions?: ToolPermission[];
  requirements?: CapabilityRequirements;
  version?: string;
  schemaVersion?: number;
}

export interface ProviderManifest {
  schemaVersion: number;
  toolApiVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  trust?: ProviderTrust;
  enabled?: boolean;
  requirements?: CapabilityRequirements;
  permissions?: ToolPermission[];
  transport: ProviderManifestTransport;
  tools?: RemoteToolPolicy[];
  healthCheckIntervalMs?: number;
  signature?: string;
}

export interface ProviderRuntimeDescriptor {
  manifest: ProviderManifest;
  source: string;
  availability: CapabilityAvailability;
  unavailableReason: string | null;
  toolIds: string[];
  connectedAt: number | null;
  lastHealthCheckAt: number | null;
  lastError: string | null;
}
