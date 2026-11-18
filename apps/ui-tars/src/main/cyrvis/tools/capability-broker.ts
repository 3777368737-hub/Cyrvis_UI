/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CapabilityCatalog } from './capability-catalog';
import { SENSITIVE_CONFIRMATION_PROMPT } from './confirmation-policy';
import type { ToolRegistry } from './registry';
import type { ToolSurface } from './tool-surface';
import type {
  CapabilityDescriptor,
  PreparedToolCall,
  ToolResult,
} from './types';

export type CapabilityConfirmationHandler = (
  prepared: PreparedToolCall,
  summary: string,
) => Promise<string | null>;

export type CapabilitySearchResult = Omit<
  CapabilityDescriptor,
  'inputSchema'
> & {
  visible: boolean;
};

export interface CapabilityDescription extends CapabilityDescriptor {
  visible: boolean;
}

export class CapabilityBroker {
  private confirmationHandler: CapabilityConfirmationHandler | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
    private readonly surface: ToolSurface,
  ) {}

  setConfirmationHandler(handler: CapabilityConfirmationHandler): void {
    this.confirmationHandler = handler;
  }

  search(query: string, limit = 20): CapabilitySearchResult[] {
    return this.catalog.search(query, limit).map((capability) => {
      const { inputSchema: _inputSchema, ...summary } = capability;
      return {
        ...summary,
        visible: this.surface.isVisible(capability.toolId),
      };
    });
  }

  describe(toolId: string): CapabilityDescription | null {
    const capability = this.catalog.get(toolId);
    return capability
      ? {
          ...capability,
          visible: this.surface.isVisible(capability.toolId),
        }
      : null;
  }

  async invoke(
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (toolId.startsWith('capability.')) {
      return failure(
        'CAPABILITY_META_TOOL_REJECTED',
        '能力 Broker 不能递归调用 capability 元工具。',
      );
    }
    const capability = this.catalog.get(toolId);
    if (!capability) {
      return failure('CAPABILITY_NOT_FOUND', `没有找到能力 ${toolId}。`);
    }
    if (
      capability.availability === 'unavailable' ||
      capability.availability === 'unknown'
    ) {
      return failure(
        'CAPABILITY_UNAVAILABLE',
        capability.unavailableReason || `${toolId} 当前不可用。`,
      );
    }

    let prepared: PreparedToolCall;
    try {
      prepared = await this.registry.prepare(toolId, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('CAPABILITY_PREPARE_FAILED', `能力参数无效：${message}`);
    }

    if (prepared.requiresConfirmation) {
      const summary =
        prepared.confirmationReason || `执行深层能力 ${capability.toolId}`;
      const prompt = this.confirmationHandler
        ? await this.confirmationHandler(prepared, summary)
        : null;
      return {
        ok: false,
        tool: 'capability.invoke',
        speech: prompt || SENSITIVE_CONFIRMATION_PROMPT,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: summary,
        },
        data: {
          status: 'confirmation_required',
          toolId: capability.toolId,
        },
      };
    }

    const result = await this.registry.executePrepared(prepared);
    this.catalog.recordCall(
      capability.toolId,
      result.ok,
      result.error?.message,
    );
    if (result.ok) {
      this.surface.activate(capability.toolId);
    }
    return {
      ...result,
      tool: 'capability.invoke',
      data: {
        toolId: capability.toolId,
        result: result.data,
      },
    };
  }
}

const failure = (code: string, speech: string): ToolResult => ({
  ok: false,
  tool: 'capability.invoke',
  speech,
  error: { code, message: speech },
});
