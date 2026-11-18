/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistry } from './registry';
import type { ToolSurface } from './tool-surface';

export interface FastToolMcpServerOptions {
  surface?: ToolSurface;
}

/**
 * In-process MCP facade over the same registry used by the voice router.
 * This keeps direct voice commands on the fast path while allowing other
 * agents to consume the exact same capability matrix over MCP transports.
 */
export const createFastToolMcpServer = (
  registry: ToolRegistry,
  options: FastToolMcpServerOptions = {},
): Server => {
  const server = new Server(
    {
      name: 'cyrvis-fast-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const definitions = options.surface
      ? options.surface.snapshot().visibleDefinitions
      : registry.list();
    return {
      tools: definitions.map((definition) => ({
        name: definition.name,
        description: `[${definition.domain}/${definition.risk}] ${definition.description}`,
        inputSchema: definition.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args =
      request.params.arguments && typeof request.params.arguments === 'object'
        ? (request.params.arguments as Record<string, unknown>)
        : {};
    const confirmation = args.__confirmed === true;
    const cleanArgs = { ...args };
    delete cleanArgs.__confirmed;
    try {
      const result = await registry.execute(request.params.name, cleanArgs, {
        confirmed: confirmation,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: !result.ok,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              tool: request.params.name,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  const notifyChanged = () => {
    void server.sendToolListChanged().catch(() => undefined);
  };
  const unsubscribe = options.surface
    ? options.surface.subscribe(notifyChanged)
    : registry.subscribe(notifyChanged);
  server.onclose = () => unsubscribe();

  return server;
};
