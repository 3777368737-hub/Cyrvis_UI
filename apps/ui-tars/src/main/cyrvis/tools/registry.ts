/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

import { SENSITIVE_CONFIRMATION_PROMPT } from './confirmation-policy';
import { PathPolicy } from './path-policy';
import { TOOL_API_VERSION } from './provider-types';
import { ToolUsageStore, type ToolUsageRecord } from './tool-usage';
import type {
  McpToolDescriptor,
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly providers = new Map<string, string>();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly usageListeners = new Set<(toolId: string) => void>();
  private readonly pathPolicy: PathPolicy;
  private currentRevision = 0;

  constructor(
    private readonly context: ToolContext,
    pathPolicy = new PathPolicy(context.cwd, context.homeDirectory),
    private readonly usageStore = new ToolUsageStore(),
  ) {
    this.pathPolicy = pathPolicy;
  }

  register(definition: ToolDefinition, providerId = 'builtin'): void {
    this.registerOne(definition, providerId);
    this.bumpRevision();
  }

  registerAll(definitions: ToolDefinition[], providerId = 'builtin'): void {
    const names = new Set<string>();
    for (const definition of definitions) {
      if (names.has(definition.name) || this.tools.has(definition.name)) {
        throw new Error(`Duplicate fast tool: ${definition.name}`);
      }
      names.add(definition.name);
    }
    for (const definition of definitions) {
      this.registerOne(definition, providerId);
    }
    if (definitions.length) {
      this.bumpRevision();
    }
  }

  unregister(name: string): boolean {
    if (!this.tools.delete(name)) {
      return false;
    }
    this.providers.delete(name);
    this.bumpRevision();
    return true;
  }

  replaceProvider(providerId: string, definitions: ToolDefinition[]): void {
    const nextNames = new Set(definitions.map((definition) => definition.name));
    if (nextNames.size !== definitions.length) {
      throw new Error(`Duplicate fast tool in provider ${providerId}`);
    }
    for (const definition of definitions) {
      const owner = this.providers.get(definition.name);
      if (owner && owner !== providerId) {
        throw new Error(
          `Fast tool ${definition.name} already belongs to ${owner}`,
        );
      }
    }
    for (const [name, owner] of [...this.providers.entries()]) {
      if (owner === providerId && !nextNames.has(name)) {
        this.tools.delete(name);
        this.providers.delete(name);
      }
    }
    for (const definition of definitions) {
      this.tools.set(definition.name, definition);
      this.providers.set(definition.name, providerId);
    }
    this.bumpRevision();
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  listByProvider(providerId: string): ToolDefinition[] {
    return this.list().filter(
      (definition) => this.getProviderId(definition.name) === providerId,
    );
  }

  getProviderId(name: string): string | null {
    return this.providers.get(name) || null;
  }

  get revision(): number {
    return this.currentRevision;
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeUsage(listener: (toolId: string) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  describeMcpTools(): McpToolDescriptor[] {
    return this.list().map((definition) => ({
      name: definition.name,
      description: `[${definition.domain}/${definition.risk}] ${definition.description}`,
      inputSchema: definition.inputSchema,
    }));
  }

  async prepare(
    tool: string,
    rawArgs: Record<string, unknown> = {},
  ): Promise<PreparedToolCall> {
    const definition = this.tools.get(tool);
    if (!definition) {
      throw new Error(`Unknown fast tool: ${tool}`);
    }
    const args = await definition.prepare(rawArgs, this.context);
    const policy = definition.pathArgs
      ? this.pathPolicy.inspect(definition.pathArgs(args))
      : {
          requiresConfirmation: false,
          reason: null,
          resolvedPaths: [],
        };
    const toolReason = definition.requiresConfirmation
      ? await definition.requiresConfirmation(args, this.context)
      : null;
    const confirmationReason = policy.reason || toolReason;
    return {
      tool: definition.name,
      args,
      definition,
      risk: definition.risk,
      requiresConfirmation: Boolean(confirmationReason),
      confirmationReason,
    };
  }

  async execute(
    tool: string,
    rawArgs: Record<string, unknown>,
    options: { confirmed?: boolean } = {},
  ): Promise<ToolResult> {
    let prepared: PreparedToolCall;
    try {
      prepared = await this.prepare(tool, rawArgs);
    } catch (error) {
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: tool,
        providerId: this.getProviderId(tool),
        ok: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      this.notifyUsage(tool);
      throw error;
    }
    return this.executePrepared(prepared, options);
  }

  async executePrepared(
    prepared: PreparedToolCall,
    options: { confirmed?: boolean } = {},
  ): Promise<ToolResult> {
    if (prepared.requiresConfirmation && options.confirmed !== true) {
      return {
        ok: false,
        tool: prepared.tool,
        speech: SENSITIVE_CONFIRMATION_PROMPT,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message:
            prepared.confirmationReason ||
            'The operation requires confirmation.',
        },
      };
    }
    const startedAt = Date.now();
    try {
      const result = await prepared.definition.execute(
        prepared.args,
        this.context,
      );
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: prepared.tool,
        providerId: this.getProviderId(prepared.tool),
        ok: result.ok,
        durationMs: Date.now() - startedAt,
        error: result.error?.message,
      });
      this.notifyUsage(prepared.tool);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        ok: false,
        tool: prepared.tool,
        speech: `操作失败：${message}`,
        error: {
          code: 'TOOL_EXECUTION_FAILED',
          message,
        },
      };
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: prepared.tool,
        providerId: this.getProviderId(prepared.tool),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      this.notifyUsage(prepared.tool);
      return result;
    }
  }

  getUsage(toolId: string): ToolUsageRecord {
    return this.usageStore.get(toolId);
  }

  get usage(): ToolUsageStore {
    return this.usageStore;
  }

  private bumpRevision(): void {
    this.currentRevision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentRevision);
      } catch {
        // Registry observers must not prevent tool registration.
      }
    }
  }

  private registerOne(definition: ToolDefinition, providerId: string): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Duplicate fast tool: ${definition.name}`);
    }
    const schemaVersion = definition.capability?.schemaVersion ?? 1;
    if (schemaVersion > TOOL_API_VERSION) {
      throw new Error(
        `Fast tool ${definition.name} requires unsupported schema version ${schemaVersion}`,
      );
    }
    this.tools.set(definition.name, definition);
    this.providers.set(definition.name, providerId);
  }

  private notifyUsage(toolId: string): void {
    for (const listener of [...this.usageListeners]) {
      try {
        listener(toolId);
      } catch {
        // Usage observers must not affect tool execution.
      }
    }
  }
}

export const createDefaultToolContext = (
  desktop: ToolContext['desktop'],
  pathPolicy = new PathPolicy(),
): ToolContext => {
  const homeDirectory = os.homedir();
  return {
    cwd: process.cwd(),
    homeDirectory,
    platform: process.platform,
    desktop,
    resolvePath: (input) => pathPolicy.resolve(input, homeDirectory),
  };
};
