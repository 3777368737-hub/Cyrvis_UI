/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ProviderManifest, RemoteToolPolicy } from './provider-types';
import type { JsonSchema, ToolDefinition, ToolResult } from './types';

const sanitizeToolName = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'tool';

const toSpeech = (value: string): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
};

const createTransport = (manifest: ProviderManifest) => {
  const transport = manifest.transport;
  if (transport.type === 'stdio') {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      cwd: transport.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...transport.env,
      },
      stderr: 'pipe',
    });
  }
  if (transport.type === 'streamable-http') {
    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: {
        headers: transport.headers,
      },
    });
  }
  if (transport.type === 'sse') {
    return new SSEClientTransport(new URL(transport.url), {
      requestInit: {
        headers: transport.headers,
      },
    });
  }
  throw new Error(`Provider ${manifest.id} does not use an external transport`);
};

export class ExternalMcpProvider {
  private client: Client | null = null;
  private transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | null = null;
  private definitions: ToolDefinition[] = [];

  constructor(private readonly manifest: ProviderManifest) {}

  declaredDefinitions(): ToolDefinition[] {
    return (this.manifest.tools || []).map((policy) =>
      this.toDefinition(
        {
          name: policy.remoteName,
          description: undefined,
          inputSchema: {},
        },
        policy,
      ),
    );
  }

  async connect(): Promise<ToolDefinition[]> {
    await this.close();
    this.transport = createTransport(this.manifest);
    this.client = new Client(
      {
        name: `cyrvis-provider-${this.manifest.id}`,
        version: '1.0.0',
      },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
    const policies = new Map(
      (this.manifest.tools || []).map((policy) => [policy.remoteName, policy]),
    );
    const listed = await this.client.listTools();
    this.definitions = listed.tools
      .filter((tool) => policies.has(tool.name))
      .map((tool) => this.toDefinition(tool, policies.get(tool.name)!));
    if (!this.definitions.length) {
      throw new Error(
        `Provider ${this.manifest.id} exposed none of its declared tools`,
      );
    }
    return this.definitions;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      await this.client.listTools();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.definitions = [];
    if (transport) {
      await transport.close().catch(() => undefined);
    }
  }

  private toDefinition(
    remote: {
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    },
    policy: RemoteToolPolicy,
  ): ToolDefinition {
    const localName = `${this.manifest.id}.${sanitizeToolName(remote.name)}`;
    return {
      name: localName,
      domain: policy.domain || 'network',
      description:
        policy.tags?.join(', ') ||
        remote.description ||
        `${this.manifest.name} remote tool ${remote.name}`,
      risk: policy.risk || 'high',
      capability: {
        providerId: this.manifest.id,
        tier: policy.tier ?? 4,
        activation: policy.activation || 'on-demand',
        priority: policy.priority ?? 20,
        tags: policy.tags,
        version: policy.version || '1.0.0',
        schemaVersion: policy.schemaVersion || 1,
        permissions: [
          ...(this.manifest.permissions || []),
          ...(policy.permissions || []),
        ],
        requirements: policy.requirements,
      },
      inputSchema: normalizeInputSchema(remote.inputSchema),
      prepare: (input) => input,
      execute: async (args): Promise<ToolResult> => {
        if (!this.client) {
          throw new Error(`Provider ${this.manifest.id} is disconnected`);
        }
        const response = await this.client.callTool({
          name: remote.name,
          arguments: args,
        });
        const content = Array.isArray(response.content)
          ? (response.content as Array<{
              type?: string;
              text?: string;
              [key: string]: unknown;
            }>)
          : [];
        const textParts = content
          .filter(
            (entry): entry is { type: 'text'; text: string } =>
              entry.type === 'text' && typeof entry.text === 'string',
          )
          .map((entry) => entry.text);
        const speech =
          textParts.length > 0
            ? toSpeech(textParts.join('\n'))
            : response.isError
              ? '远程工具执行失败。'
              : '远程工具执行完成。';
        return {
          ok: response.isError !== true,
          tool: localName,
          speech,
          data: {
            providerId: this.manifest.id,
            remoteTool: remote.name,
            content,
            structuredContent: response.structuredContent,
          },
          ...(response.isError
            ? {
                error: {
                  code: 'REMOTE_TOOL_FAILED',
                  message: speech,
                },
              }
            : {}),
        };
      },
    };
  }

  get connected(): boolean {
    return Boolean(this.client);
  }
}

const normalizeInputSchema = (input: Record<string, unknown>): JsonSchema => {
  if (
    input.type !== 'object' ||
    !input.properties ||
    typeof input.properties !== 'object' ||
    Array.isArray(input.properties)
  ) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
  }
  return {
    type: 'object',
    properties: input.properties as Record<string, unknown>,
    required: Array.isArray(input.required)
      ? input.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : undefined,
    additionalProperties:
      typeof input.additionalProperties === 'boolean'
        ? input.additionalProperties
        : true,
  };
};
