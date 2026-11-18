/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CapabilityBroker,
  CapabilitySearchResult,
} from './capability-broker';
import type { ProviderRegistry } from './provider-registry';
import type { ToolDefinition, ToolResult } from './types';

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key].trim() : fallback);

const number = (value: unknown, fallback: number, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : fallback;

const availabilityLabel = (capability: CapabilitySearchResult): string => {
  if (capability.availability === 'available') {
    return '可用';
  }
  if (capability.availability === 'degraded') {
    return '降级';
  }
  if (capability.availability === 'unknown') {
    return '状态未知';
  }
  return '不可用';
};

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (tool: string, speech: string): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: {
    code: 'CAPABILITY_TOOL_FAILED',
    message: speech,
  },
});

export const createCapabilityTools = (
  broker: CapabilityBroker,
  providers?: ProviderRegistry,
): ToolDefinition[] => [
  {
    name: 'capability.search',
    domain: 'capability',
    description:
      'Search the complete CYRVIS capability catalog, including hidden, state-gated, degraded, and currently unavailable tools.',
    risk: 'low',
    capability: {
      providerId: 'capability',
      tier: 0,
      activation: 'always',
      priority: 100,
      tags: ['capability', 'tool', '能力', '工具'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query'),
      limit: number(input.limit, 20, 100),
    }),
    async execute(args) {
      const capabilities = broker.search(
        String(args.query),
        Number(args.limit),
      );
      return success(
        'capability.search',
        capabilities.length
          ? `找到 ${capabilities.length} 项能力。`
          : '没有找到匹配的能力。',
        { capabilities },
      );
    },
  },
  {
    name: 'capability.providers',
    domain: 'capability',
    description:
      'List dynamic tool providers with trust, transport type, availability, health, and capability IDs without exposing manifest secrets.',
    risk: 'low',
    capability: {
      providerId: 'capability',
      tier: 0,
      activation: 'always',
      priority: 97,
      tags: ['capability', 'provider', '能力', '提供者'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const providerStates = (providers?.list() || []).map((provider) => ({
        id: provider.manifest.id,
        name: provider.manifest.name,
        version: provider.manifest.version,
        trust: provider.manifest.trust || 'untrusted',
        transport: provider.manifest.transport.type,
        availability: provider.availability,
        unavailableReason: provider.unavailableReason,
        permissions: provider.manifest.permissions || [],
        toolIds: provider.toolIds,
        connectedAt: provider.connectedAt,
        lastHealthCheckAt: provider.lastHealthCheckAt,
        lastError: provider.lastError,
      }));
      return success(
        'capability.providers',
        `当前管理 ${providerStates.length} 个动态 Provider。`,
        { providers: providerStates },
      );
    },
  },
  {
    name: 'capability.describe',
    domain: 'capability',
    description:
      'Describe one CYRVIS capability, including its current availability, risk, exposure tier, and input schema.',
    risk: 'low',
    capability: {
      providerId: 'capability',
      tier: 0,
      activation: 'always',
      priority: 99,
      tags: ['capability', 'schema', '能力', '参数'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
      },
      required: ['toolId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ toolId: text(input, 'toolId') }),
    async execute(args) {
      const capability = broker.describe(String(args.toolId));
      if (!capability) {
        return failure(
          'capability.describe',
          `没有找到能力 ${String(args.toolId)}。`,
        );
      }
      return success(
        'capability.describe',
        `${capability.toolId} 当前${availabilityLabel(capability)}${
          capability.unavailableReason
            ? `，原因：${capability.unavailableReason}`
            : ''
        }。`,
        { capability },
      );
    },
  },
  {
    name: 'capability.invoke',
    domain: 'capability',
    description:
      'Invoke any available CYRVIS capability by tool ID after validating its schema, state, risk, path policy, and confirmation requirements.',
    risk: 'low',
    capability: {
      providerId: 'capability',
      tier: 0,
      activation: 'always',
      priority: 98,
      tags: ['capability', 'invoke', '能力', '调用'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        arguments: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['toolId', 'arguments'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      toolId: text(input, 'toolId'),
      arguments:
        input.arguments &&
        typeof input.arguments === 'object' &&
        !Array.isArray(input.arguments)
          ? (input.arguments as Record<string, unknown>)
          : {},
    }),
    async execute(args) {
      return broker.invoke(
        String(args.toolId),
        args.arguments as Record<string, unknown>,
      );
    },
  },
];
