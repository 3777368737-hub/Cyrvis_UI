/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CyrvisController } from './controller';
import { createFastToolMatrix, SENSITIVE_CONFIRMATION_PROMPT } from './tools';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from './tools';
import type { GUIAdapter, GUIAdapterCallbacks } from './types';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import { VoiceBrain } from './voice-brain';

class NoopGUIAdapter implements GUIAdapter {
  started = false;

  async start(
    _instruction: string,
    callbacks: GUIAdapterCallbacks,
  ): Promise<void> {
    this.started = true;
    callbacks.onStarted();
  }

  async cancel(): Promise<void> {
    return undefined;
  }

  async pause(): Promise<void> {
    return undefined;
  }

  async resume(): Promise<void> {
    return undefined;
  }
}

class FakeProvider implements VoiceProvider {
  readonly spoken: string[] = [];
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  canceled = 0;

  constructor(readonly callbacks: VoiceProviderCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onReady?.();
  }

  sendAudio(): void {
    return undefined;
  }

  sendToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
  }

  cancelResponse(): void {
    this.canceled += 1;
  }

  speak(text: string): void {
    this.spoken.push(text);
    this.callbacks.onResponseStarted?.();
    this.callbacks.onResponseDone?.();
  }

  close(): void {
    return undefined;
  }

  transcript(text: string): boolean | void {
    return this.callbacks.onTranscript?.(text, true);
  }

  toolCall(call: VoiceToolCallWithId): void {
    this.callbacks.onToolCall?.(call);
  }

  assistantText(text: string): void {
    this.callbacks.onAssistantText?.(text, true);
  }

  audio(): void {
    this.callbacks.onAudio?.(new Int16Array([1]));
  }

  responseStarted(): void {
    this.callbacks.onResponseStarted?.();
  }

  responseDone(): void {
    this.callbacks.onResponseDone?.();
  }

  speechText(text: string, final = true): void {
    this.callbacks.onSpeechText?.(text, final);
  }
}

class FakeDesktopHost implements DesktopHost {
  readonly launched: string[] = [];
  readonly closed: string[] = [];
  readonly presentations: string[] = [];
  readonly openedUrls: string[] = [];
  minimizedAll = 0;

  async openPath(): Promise<void> {
    return undefined;
  }

  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  async clipboardRead(): Promise<string> {
    return '';
  }

  async clipboardWrite(): Promise<void> {
    return undefined;
  }

  async launchApplication(name: string): Promise<string> {
    this.launched.push(name);
    return name;
  }

  async closeApplication(name: string): Promise<string> {
    this.closed.push(name);
    return name;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return [];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [];
  }

  async controlWindow(query: string): Promise<string> {
    return query;
  }

  async minimizeAllWindows(): Promise<number> {
    this.minimizedAll += 1;
    return 4;
  }

  async restoreAllWindows(): Promise<number> {
    return 4;
  }

  async createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void> {
    this.presentations.push(input.path);
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: 'test',
      release: '1.0',
      architecture: 'x64',
      hostname: 'test',
      homeDirectory: os.homedir(),
      cpuCount: 1,
      totalMemoryBytes: 1,
      freeMemoryBytes: 1,
      uptimeSeconds: 1,
    };
  }

  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 1, freeBytes: 1 };
  }
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceBrain fast tool interception', () => {
  it('executes a simple command locally and blocks a racing GUI tool call', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('open notepad');
    provider.toolCall({
      callId: 'race-call',
      name: 'start_gui_task',
      args: { instruction: 'open notepad' },
    });
    provider.toolCall({
      callId: 'duplicate-local-call',
      name: 'cyrvis_app_launch',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();

    expect(desktop.launched).toEqual(['notepad']);
    expect(adapter.started).toBe(false);
    expect(provider.canceled).toBeGreaterThan(0);
    expect(provider.spoken).toContain('正在打开notepad。');
    expect(provider.toolResults[0]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
    expect(provider.toolResults[1]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
  });

  it('auto-wakes on a deterministic fast-tool command', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: true,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('open notepad');
    await flush();
    await flush();

    expect(brain.getState().awake).toBe(true);
    expect(desktop.launched).toEqual(['notepad']);
  });

  it('minimizes all windows locally instead of dispatching the GUI agent', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('把所有桌面窗口最小化');
    provider.toolCall({
      callId: 'window-race',
      name: 'start_gui_task',
      args: { instruction: '把所有桌面窗口最小化' },
    });
    await flush();
    await flush();

    expect(desktop.minimizedAll).toBe(1);
    expect(adapter.started).toBe(false);
    expect(provider.spoken).toContain('已最小化 4 个可见窗口。');
    expect(provider.toolResults[0]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
  });

  it('executes a local tool selected directly by the language model', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('让桌面清爽一点');
    provider.toolCall({
      callId: 'model-local-window',
      name: 'cyrvis_window_minimize_all',
      args: {},
    });
    await flush();
    await flush();

    expect(desktop.minimizedAll).toBe(1);
    expect(adapter.started).toBe(false);
    expect(provider.toolResults[0]?.output).toContain('"status":"completed"');
    expect(provider.toolResults[0]?.output).toContain('window.minimize_all');
  });

  it('allows GUI fallback after capability discovery finds no handled task', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('打开浏览器并登录我的邮箱');
    provider.toolCall({
      callId: 'capability-discovery',
      name: 'cyrvis_capability_search',
      args: { query: 'mail login' },
    });
    await flush();
    await flush();
    provider.toolCall({
      callId: 'gui-fallback',
      name: 'start_gui_task',
      args: { instruction: '打开浏览器并登录我的邮箱' },
    });
    await flush();
    await flush();

    expect(adapter.started).toBe(true);
    expect(provider.toolResults[0]?.output).toContain('"status":"completed"');
  });

  it('redirects a browser search GUI call to the local web search tool', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('网球王子这个信息帮我弄出来');
    provider.toolCall({
      callId: 'search-gui-fallback',
      name: 'start_gui_task',
      args: { instruction: '打开浏览器搜索网球王子' },
    });
    await flush();
    await flush();

    expect(adapter.started).toBe(false);
    expect(decodeURIComponent(desktop.openedUrls.at(-1) || '')).toContain(
      '网球王子',
    );
    expect(provider.toolResults.at(-1)?.output).toContain(
      '"status":"completed"',
    );
  });

  it('keeps high-risk tools behind confirmation and bypasses confirm self-echo filtering', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('处理一下记事本应用');
    provider.toolCall({
      callId: 'model-close-app',
      name: 'cyrvis_app_close',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();

    expect(desktop.closed).toEqual([]);
    expect(provider.toolResults).toEqual([]);
    expect(provider.spoken.at(-1)).toBe(SENSITIVE_CONFIRMATION_PROMPT);
    expect(provider.canceled).toBeGreaterThan(0);

    const confirmationPromptCount = provider.spoken.length;
    provider.toolCall({
      callId: 'model-close-app-repeat',
      name: 'cyrvis_app_close',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();
    expect(provider.spoken).toHaveLength(confirmationPromptCount);

    provider.assistantText(SENSITIVE_CONFIRMATION_PROMPT);
    provider.audio();

    const consumed = provider.transcript('确认执行');
    expect(consumed).toBe(true);
    await flush();
    await flush();

    expect(desktop.closed).toEqual(['notepad']);
  });

  it('speaks confirmation for a high-risk capability invoked through the broker', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('处理一下记事本应用');
    provider.toolCall({
      callId: 'broker-close-app',
      name: 'cyrvis_capability_invoke',
      args: {
        toolId: 'app.close',
        arguments: { name: 'notepad' },
      },
    });
    await flush();
    await flush();

    expect(desktop.closed).toEqual([]);
    expect(provider.spoken.at(-1)).toBe(SENSITIVE_CONFIRMATION_PROMPT);
    expect(provider.canceled).toBeGreaterThan(0);
    expect(matrix.router.hasPendingConfirmation()).toBe(true);

    provider.transcript('确认执行');
    await flush();
    await flush();
    expect(desktop.closed).toEqual(['notepad']);
  });

  it('recovers confirmation by replaying the last actionable command when pending is lost', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('关闭应用记事本');
    await flush();
    expect(desktop.closed).toEqual([]);
    provider.assistantText(SENSITIVE_CONFIRMATION_PROMPT);

    provider.transcript('取消');
    await flush();
    expect(desktop.closed).toEqual([]);

    provider.assistantText(`取消完成。${SENSITIVE_CONFIRMATION_PROMPT}`);
    provider.transcript('确认执行');
    await flush();
    await flush();

    expect(desktop.closed).toEqual(['记事本']);
  });

  it('speaks final assistant text when no audio was generated', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.responseStarted();
    provider.assistantText('这是一条需要在聊天框和语音中同时出现的重要信息。');
    provider.responseDone();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(provider.spoken).toContain(
      '这是一条需要在聊天框和语音中同时出现的重要信息。',
    );
  });

  it('does not duplicate a speech-text response that is already being synthesized', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.responseStarted();
    provider.assistantText('已经有 TTS 输入的回复。');
    provider.speechText('已经有 TTS 输入的回复。');
    provider.responseDone();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(provider.spoken).not.toContain('已经有 TTS 输入的回复。');
  });

  it('guarantees a fallback reply when a user turn produces no output', async () => {
    vi.useFakeTimers();
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('请解释一个比较复杂的问题');
    await vi.advanceTimersByTimeAsync(6000);

    expect(provider.spoken).toContain('我在，正在理解你的请求，请稍等。');
  });
});
