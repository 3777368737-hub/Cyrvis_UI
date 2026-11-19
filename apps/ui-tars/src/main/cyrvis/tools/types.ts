/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type ToolDomain =
  | 'filesystem'
  | 'desktop'
  | 'clipboard'
  | 'system'
  | 'office'
  | 'network'
  | 'capability';

export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolExposureTier = 0 | 1 | 2 | 3 | 4;
export type CapabilityAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type ToolPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'desktop.app'
  | 'desktop.window'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'system.read'
  | 'system.process'
  | 'network'
  | 'office'
  | 'process.spawn'
  | 'remote.tools';

export interface CapabilityRequirements {
  platforms?: NodeJS.Platform[];
  applications?: string[];
  services?: string[];
  environment?: string[];
  executables?: string[];
  steamGamesMin?: number;
  permissions?: ToolPermission[];
}

export interface ToolCapabilityMetadata {
  providerId?: string;
  tier?: ToolExposureTier;
  activation?: 'always' | 'state' | 'on-demand';
  priority?: number;
  tags?: string[];
  version?: string;
  schemaVersion?: number;
  permissions?: ToolPermission[];
  requirements?: CapabilityRequirements;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  speech: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface DesktopHost {
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  openSearch?(url: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  launchApplication(name: string, target?: string): Promise<string>;
  closeApplication(name: string): Promise<string>;
  listProcesses(): Promise<ProcessInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  controlWindow(
    query: string,
    action: 'focus' | 'minimize' | 'maximize' | 'close',
  ): Promise<string>;
  minimizeAllWindows(): Promise<number>;
  restoreAllWindows(): Promise<number>;
  createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void>;
  systemInfo(): Promise<SystemInfo>;
  diskInfo(path: string): Promise<DiskInfo>;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  title?: string;
  memoryBytes?: number;
}

export interface WindowInfo {
  pid: number;
  process: string;
  title: string;
}

export interface SystemInfo {
  platform: string;
  release: string;
  architecture: string;
  hostname: string;
  homeDirectory: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  uptimeSeconds: number;
}

export interface DiskInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ToolContext {
  cwd: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
  desktop: DesktopHost;
  resolvePath(input: string): string;
}

export interface ToolDefinition<
  Args extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  domain: ToolDomain;
  description: string;
  risk: ToolRisk;
  capability?: ToolCapabilityMetadata;
  inputSchema: JsonSchema;
  prepare(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Args | Promise<Args>;
  pathArgs?(args: Args): string[];
  requiresConfirmation?(
    args: Args,
    context: ToolContext,
  ): string | null | Promise<string | null>;
  execute(args: Args, context: ToolContext): Promise<ToolResult>;
}

export interface PreparedToolCall {
  tool: string;
  args: Record<string, unknown>;
  definition: ToolDefinition;
  risk: ToolRisk;
  requiresConfirmation: boolean;
  confirmationReason: string | null;
}

export interface FastToolRoute {
  kind: 'execute' | 'confirm' | 'cancel';
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  requiresConfirmation: boolean;
  confirmationReason: string | null;
  risk: ToolRisk;
  domain: ToolDomain;
}

export interface FastToolOutcome {
  handled: boolean;
  ok?: boolean;
  speech?: string;
  result?: ToolResult;
  route?: FastToolRoute;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface CapabilityDescriptor {
  id: string;
  toolId: string;
  providerId: string;
  name: string;
  description: string;
  domain: ToolDomain;
  risk: ToolRisk;
  tier: ToolExposureTier;
  activation: 'always' | 'state' | 'on-demand';
  priority: number;
  tags: string[];
  version: string;
  schemaVersion: number;
  permissions: ToolPermission[];
  requirements: CapabilityRequirements;
  availability: CapabilityAvailability;
  unavailableReason: string | null;
  usage: {
    successes: number;
    failures: number;
    lastUsedAt: number | null;
  };
  inputSchema: JsonSchema;
}
