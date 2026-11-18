/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import WebSocket from 'ws';

import { describe, expect, it, vi } from 'vitest';

import { QwenOmniProvider } from './qwen-omni';
import type { QwenToolDefinition } from './tools';

describe('QwenOmniProvider tool surface', () => {
  it('queues a session update when the dynamic tool list changes', () => {
    const provider = new QwenOmniProvider({
      apiKey: 'test-key',
      callbacks: {},
    });
    const send = vi.fn();
    const internals = provider as unknown as {
      connected: boolean;
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
    };
    internals.connected = true;
    internals.ws = { readyState: WebSocket.OPEN, send };
    const tools: QwenToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'cyrvis_capability_search',
          description: 'Search capabilities.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      },
    ];

    provider.setTools?.(tools);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(send.mock.calls[0]?.[0])) as {
      type: string;
      session: { tools: QwenToolDefinition[] };
    };
    expect(payload.type).toBe('session.update');
    expect(payload.session.tools).toEqual(tools);

    provider.setTools?.(tools);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reverts rejected dynamic tools before reconnecting', () => {
    const provider = new QwenOmniProvider({
      apiKey: 'test-key',
      callbacks: {},
    });
    const send = vi.fn();
    const close = vi.fn();
    const internals = provider as unknown as {
      connected: boolean;
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      tools: QwenToolDefinition[];
      lastAcceptedTools: QwenToolDefinition[];
      handleMessage(raw: Buffer): void;
    };
    const acceptedNames = internals.tools.map((tool) => tool.function.name);
    internals.connected = true;
    internals.ws = {
      readyState: WebSocket.OPEN,
      send,
      close,
    };
    provider.setTools?.([
      {
        type: 'function',
        function: {
          name: 'cyrvis_incompatible',
          description: 'Incompatible tool.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ]);
    const event = Buffer.from(
      JSON.stringify({
        type: 'error',
        error: { message: 'invalid tool schema in session.update' },
      }),
    );

    internals.handleMessage(event);
    internals.handleMessage(event);

    expect(internals.tools.map((tool) => tool.function.name)).toEqual(
      acceptedNames,
    );
    expect(close).toHaveBeenCalled();
    provider.close();
  });
});
