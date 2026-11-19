/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PROVIDER_MANIFEST_SCHEMA_VERSION,
  TOOL_API_VERSION,
  type ProviderManifest,
  type ProviderManifestTransport,
  type RemoteToolPolicy,
} from './provider-types';
import type {
  CapabilityRequirements,
  ToolDomain,
  ToolExposureTier,
  ToolPermission,
  ToolRisk,
} from './types';

export interface LoadedProviderManifest {
  manifest: ProviderManifest;
  source: string;
}

export interface ProviderManifestLoadResult {
  manifests: LoadedProviderManifest[];
  errors: Array<{ source: string; error: string }>;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const TOOL_DOMAINS = new Set<ToolDomain>([
  'filesystem',
  'desktop',
  'clipboard',
  'system',
  'office',
  'network',
  'capability',
]);
const TOOL_RISKS = new Set<ToolRisk>(['low', 'medium', 'high']);
const TOOL_TIERS = new Set<ToolExposureTier>([0, 1, 2, 3, 4]);
const TOOL_PERMISSIONS = new Set<ToolPermission>([
  'filesystem.read',
  'filesystem.write',
  'desktop.app',
  'desktop.window',
  'desktop.screen',
  'desktop.input',
  'clipboard.read',
  'clipboard.write',
  'system.read',
  'system.process',
  'system.media',
  'system.power',
  'network',
  'office',
  'process.spawn',
  'remote.tools',
]);

const asString = (
  value: unknown,
  field: string,
  options: { max?: number; optional?: boolean } = {},
): string | undefined => {
  if (value === undefined && options.optional) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const result = value.trim();
  if (options.max && result.length > options.max) {
    throw new Error(`${field} exceeds ${options.max} characters`);
  }
  return result;
};

const asStringArray = (
  value: unknown,
  field: string,
  maximum = 100,
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
};

const asRequirements = (
  value: unknown,
  field: string,
): CapabilityRequirements | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const platforms = asStringArray(input.platforms, `${field}.platforms`, 10);
  const permissions = asStringArray(
    input.permissions,
    `${field}.permissions`,
    30,
  );
  if (
    permissions?.some(
      (permission) => !TOOL_PERMISSIONS.has(permission as ToolPermission),
    )
  ) {
    throw new Error(`${field}.permissions contains an unsupported permission`);
  }
  const steamGamesMin =
    input.steamGamesMin === undefined ? undefined : Number(input.steamGamesMin);
  if (
    steamGamesMin !== undefined &&
    (!Number.isInteger(steamGamesMin) || steamGamesMin < 0)
  ) {
    throw new Error(`${field}.steamGamesMin must be a non-negative integer`);
  }
  return {
    platforms: platforms as NodeJS.Platform[] | undefined,
    applications: asStringArray(input.applications, `${field}.applications`),
    services: asStringArray(input.services, `${field}.services`),
    environment: asStringArray(input.environment, `${field}.environment`),
    executables: asStringArray(input.executables, `${field}.executables`),
    steamGamesMin,
    permissions: permissions as ToolPermission[] | undefined,
  };
};

const asPermissionList = (
  value: unknown,
  field: string,
): ToolPermission[] | undefined => {
  const permissions = asStringArray(value, field, 30);
  if (
    permissions?.some(
      (permission) => !TOOL_PERMISSIONS.has(permission as ToolPermission),
    )
  ) {
    throw new Error(`${field} contains an unsupported permission`);
  }
  return permissions as ToolPermission[] | undefined;
};

const asActivationPolicy = (value: unknown): ProviderManifest['activation'] => {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('activation must be an object');
  }
  const input = value as Record<string, unknown>;
  const mode = asString(input.mode, 'activation.mode', {
    max: 20,
    optional: true,
  });
  if (mode && mode !== 'always' && mode !== 'foreground') {
    throw new Error('activation.mode must be "always" or "foreground"');
  }
  return {
    mode: mode as 'always' | 'foreground' | undefined,
    applications: asStringArray(input.applications, 'activation.applications'),
    processes: asStringArray(input.processes, 'activation.processes'),
  };
};

const asToolPolicy = (value: unknown, index: number): RemoteToolPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`tools[${index}] must be an object`);
  }
  const input = value as Record<string, unknown>;
  const remoteName = asString(input.remoteName, `tools[${index}].remoteName`, {
    max: 200,
  })!;
  const domain = asString(input.domain, `tools[${index}].domain`, {
    max: 40,
    optional: true,
  }) as ToolDomain | undefined;
  if (domain && !TOOL_DOMAINS.has(domain)) {
    throw new Error(`tools[${index}].domain is unsupported`);
  }
  const risk = asString(input.risk, `tools[${index}].risk`, {
    max: 20,
    optional: true,
  }) as ToolRisk | undefined;
  if (risk && !TOOL_RISKS.has(risk)) {
    throw new Error(`tools[${index}].risk is unsupported`);
  }
  const tier =
    input.tier === undefined
      ? undefined
      : (Number(input.tier) as ToolExposureTier);
  if (tier !== undefined && !TOOL_TIERS.has(tier)) {
    throw new Error(`tools[${index}].tier is unsupported`);
  }
  const priority =
    input.priority === undefined ? undefined : Number(input.priority);
  if (priority !== undefined && !Number.isFinite(priority)) {
    throw new Error(`tools[${index}].priority must be a finite number`);
  }
  const schemaVersion =
    input.schemaVersion === undefined ? undefined : Number(input.schemaVersion);
  if (
    schemaVersion !== undefined &&
    (!Number.isInteger(schemaVersion) || schemaVersion > TOOL_API_VERSION)
  ) {
    throw new Error(`tools[${index}].schemaVersion is unsupported`);
  }
  return {
    remoteName,
    domain,
    risk,
    tier,
    activation:
      input.activation === 'always' ||
      input.activation === 'state' ||
      input.activation === 'on-demand'
        ? input.activation
        : undefined,
    priority,
    tags: asStringArray(input.tags, `tools[${index}].tags`),
    permissions: asPermissionList(
      input.permissions,
      `tools[${index}].permissions`,
    ),
    requirements: asRequirements(
      input.requirements,
      `tools[${index}].requirements`,
    ),
    version: asString(input.version, `tools[${index}].version`, {
      max: 40,
      optional: true,
    }),
    schemaVersion,
  };
};

const asTransport = (value: unknown): ProviderManifestTransport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transport must be an object');
  }
  const input = value as Record<string, unknown>;
  const type = asString(input.type, 'transport.type', { max: 30 });
  if (type === 'builtin') {
    return {
      type,
      toolIds: asStringArray(input.toolIds, 'transport.toolIds', 200),
    };
  }
  if (type === 'stdio') {
    const command = asString(input.command, 'transport.command', {
      max: 500,
    })!;
    if (/[\r\n]/.test(command)) {
      throw new Error('transport.command must not contain line breaks');
    }
    const env =
      input.env && typeof input.env === 'object' && !Array.isArray(input.env)
        ? (input.env as Record<string, string>)
        : undefined;
    return {
      type,
      command,
      args: asStringArray(input.args, 'transport.args', 100),
      cwd: asString(input.cwd, 'transport.cwd', {
        max: 1000,
        optional: true,
      }),
      env,
    };
  }
  if (type === 'streamable-http' || type === 'sse') {
    const url = new URL(asString(input.url, 'transport.url', { max: 2000 })!);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('transport.url must use http or https');
    }
    const headers =
      input.headers &&
      typeof input.headers === 'object' &&
      !Array.isArray(input.headers)
        ? Object.fromEntries(
            Object.entries(input.headers as Record<string, unknown>).map(
              ([key, entry]) => {
                if (typeof entry !== 'string') {
                  throw new Error('transport.headers values must be strings');
                }
                return [key, entry];
              },
            ),
          )
        : undefined;
    return { type, url: url.toString(), headers };
  }
  throw new Error(
    'transport.type must be builtin, stdio, streamable-http, or sse',
  );
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(input[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const providerManifestPayload = (
  manifest: ProviderManifest | Record<string, unknown>,
): string => {
  const { signature: _signature, ...payload } = manifest as Record<
    string,
    unknown
  >;
  return canonicalize(payload);
};

export const verifyProviderManifestSignature = (
  manifest: ProviderManifest | Record<string, unknown>,
  publicKeyPem: string,
  signature: string,
): boolean => {
  const [requestedAlgorithm, encodedSignature] = signature.includes(':')
    ? signature.split(':', 2)
    : ['ed25519', signature];
  try {
    const data = Buffer.from(providerManifestPayload(manifest), 'utf8');
    const key = crypto.createPublicKey(publicKeyPem.replace(/\\n/g, '\n'));
    return crypto.verify(
      requestedAlgorithm === 'rsa-sha256' ? 'RSA-SHA256' : null,
      data,
      key,
      Buffer.from(encodedSignature, 'base64'),
    );
  } catch {
    return false;
  }
};

export const parseProviderManifest = (
  value: unknown,
  options: {
    publicKeyPem?: string;
    allowUntrusted?: boolean;
    allowBuiltin?: boolean;
  } = {},
): ProviderManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const schemaVersion = Number(input.schemaVersion);
  const toolApiVersion = Number(input.toolApiVersion);
  if (schemaVersion !== PROVIDER_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported manifest schema version ${schemaVersion}; expected ${PROVIDER_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (toolApiVersion !== TOOL_API_VERSION) {
    throw new Error(
      `unsupported tool API version ${toolApiVersion}; expected ${TOOL_API_VERSION}`,
    );
  }
  const id = asString(input.id, 'id', { max: 64 })!;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      'id must contain only letters, numbers, dot, underscore, or dash',
    );
  }
  const trust =
    input.trust === 'builtin' ||
    input.trust === 'trusted' ||
    input.trust === 'untrusted'
      ? input.trust
      : 'untrusted';
  if (trust === 'builtin' && !options.allowBuiltin) {
    throw new Error(
      'builtin trust is reserved for manifests shipped with CYRVIS',
    );
  }
  const signature = asString(input.signature, 'signature', {
    max: 20_000,
    optional: true,
  });
  const healthCheckIntervalMs =
    input.healthCheckIntervalMs === undefined
      ? undefined
      : Number(input.healthCheckIntervalMs);
  if (
    healthCheckIntervalMs !== undefined &&
    (!Number.isFinite(healthCheckIntervalMs) || healthCheckIntervalMs < 1_000)
  ) {
    throw new Error('healthCheckIntervalMs must be at least 1000');
  }
  if (trust === 'trusted') {
    if (!options.publicKeyPem || !signature) {
      throw new Error(
        'trusted providers require a configured public key and signature',
      );
    }
    const parsedWithoutSignature: ProviderManifest = {
      schemaVersion,
      toolApiVersion,
      id,
      name: asString(input.name, 'name', { max: 120 })!,
      version: asString(input.version, 'version', { max: 40 })!,
      description: asString(input.description, 'description', {
        max: 500,
        optional: true,
      }),
      trust,
      enabled: input.enabled !== false,
      requirements: asRequirements(input.requirements, 'requirements'),
      activation: asActivationPolicy(input.activation),
      permissions: asPermissionList(input.permissions, 'permissions'),
      transport: asTransport(input.transport),
      tools: Array.isArray(input.tools)
        ? input.tools.map(asToolPolicy)
        : undefined,
      healthCheckIntervalMs,
      signature,
    };
    if (
      !verifyProviderManifestSignature(input, options.publicKeyPem, signature)
    ) {
      throw new Error('provider manifest signature verification failed');
    }
    return parsedWithoutSignature;
  }
  if (trust === 'untrusted' && !options.allowUntrusted) {
    throw new Error(
      'untrusted provider is disabled; configure a trusted signature or CYRVIS_ALLOW_UNTRUSTED_PROVIDERS=1',
    );
  }
  return {
    schemaVersion,
    toolApiVersion,
    id,
    name: asString(input.name, 'name', { max: 120 })!,
    version: asString(input.version, 'version', { max: 40 })!,
    description: asString(input.description, 'description', {
      max: 500,
      optional: true,
    }),
    trust,
    enabled: input.enabled !== false,
    requirements: asRequirements(input.requirements, 'requirements'),
    activation: asActivationPolicy(input.activation),
    permissions: asPermissionList(input.permissions, 'permissions'),
    transport: asTransport(input.transport),
    tools: Array.isArray(input.tools)
      ? input.tools.map(asToolPolicy)
      : undefined,
    healthCheckIntervalMs,
    signature,
  };
};

export const loadProviderManifests = async (
  directory: string,
  options: {
    publicKeyPem?: string;
    allowUntrusted?: boolean;
    allowBuiltin?: boolean;
  } = {},
): Promise<ProviderManifestLoadResult> => {
  const result: ProviderManifestLoadResult = { manifests: [], errors: [] };
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }
    const source = path.join(directory, entry.name);
    try {
      const content = await fs.readFile(source, 'utf8');
      const manifest = parseProviderManifest(JSON.parse(content), options);
      result.manifests.push({ manifest, source });
    } catch (error) {
      result.errors.push({
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
};
