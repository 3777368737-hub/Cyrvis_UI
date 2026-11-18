/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CyrvisController } from './controller';
import type { ControllerEvent, GUIAdapter, GUIAdapterCallbacks } from './types';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import { VoiceBrain, type VoiceBrainCallbacks } from './voice-brain';

class FakeGUIAdapter implements GUIAdapter {
  callbacks: GUIAdapterCallbacks | null = null;
  instruction = '';
  private resolveStart: (() => void) | null = null;

  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void> {
    this.instruction = instruction;
    this.callbacks = callbacks;
    callbacks.onStarted();
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.callbacks?.onCancelled();
  }

  async pause(): Promise<void> {
    this.callbacks?.onPaused();
  }

  async resume(): Promise<void> {
    this.callbacks?.onResumed();
  }

  finish(summary = '任务完成'): void {
    this.callbacks?.onDone(summary);
    this.resolveStart?.();
  }
}

class FakeProvider implements VoiceProvider {
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  readonly spoken: string[] = [];
  readonly audio: Int16Array[] = [];
  canceled = 0;
  connected = false;

  constructor(readonly callbacks: VoiceProviderCallbacks) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.callbacks.onReady?.();
  }

  sendAudio(pcm16: Int16Array): void {
    this.audio.push(pcm16);
  }

  sendToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
    this.callbacks.onResponseStarted?.();
    this.callbacks.onResponseDone?.();
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
    this.connected = false;
  }

  emitTranscript(text: string, final = true): void {
    this.callbacks.onTranscript?.(text, final);
  }

  emitToolCall(call: VoiceToolCallWithId): void {
    this.callbacks.onToolCall?.(call);
  }

  emitAudio(pcm: Int16Array): void {
    this.callbacks.onAudio?.(pcm);
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const setup = (options?: {
  requireWakeWord?: boolean;
  awakeTimeoutMs?: number;
  rememberFact?: (text: string) => Promise<string | null>;
}) => {
  const adapter = new FakeGUIAdapter();
  const controller = new CyrvisController(adapter, {
    stallTimeoutMs: 0,
    idFactory: () => 'task-1',
  });
  const events: ControllerEvent[] = [];
  controller.onEvent((event) => events.push(event));

  let provider!: FakeProvider;
  const wakeEvents: string[] = [];
  const audioOut: Int16Array[] = [];
  const callbacks: VoiceBrainCallbacks = {
    onWake: () => wakeEvents.push('wake'),
    onSleep: () => wakeEvents.push('sleep'),
    onAudio: (pcm) => audioOut.push(pcm),
  };

  const brain = new VoiceBrain(
    controller,
    callbacks,
    (providerCallbacks) => {
      provider = new FakeProvider(providerCallbacks);
      return provider;
    },
    {
      requireWakeWord: options?.requireWakeWord ?? true,
      awakeTimeoutMs: options?.awakeTimeoutMs ?? 0,
      rememberFact: options?.rememberFact,
    },
  );

  return { adapter, controller, events, brain, provider, wakeEvents, audioOut };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceBrain', () => {
  it('wakes on an explicit greeting', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('你好', true);

    expect(brain.getState().awake).toBe(true);
  });

  it('routes explicit remember requests through long-term memory', async () => {
    const remembered: string[] = [];
    const { brain, provider } = setup({
      requireWakeWord: false,
      rememberFact: async (text) => {
        remembered.push(text);
        return text;
      },
    });
    await brain.start();

    provider.emitToolCall({
      callId: 'memory-1',
      name: 'remember_fact',
      args: { text: '用户喜欢简洁回答' },
    });
    await flush();

    expect(remembered).toEqual(['用户喜欢简洁回答']);
    expect(provider.toolResults.at(-1)?.output).toContain('用户喜欢简洁回答');
  });

  it('does not wake on unrelated background speech', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('今天天气不错', true);

    expect(brain.getState().awake).toBe(false);
    expect(provider.canceled).toBe(1);
  });

  it('wakes on "Hello CYRVIS" ASR variants', async () => {
    const { brain, provider, wakeEvents } = setup();
    await brain.start();

    provider.emitTranscript('Hello, service.', true);
    expect(brain.getState().awake).toBe(true);

    const second = setup();
    await second.brain.start();
    second.provider.emitTranscript('Hello, Cyrus.', true);
    expect(second.brain.getState().awake).toBe(true);
    expect(wakeEvents).toContain('wake');
  });

  it('auto-wakes on a clear task command without the wake word', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('打开记事本输入 Hello', true);

    expect(brain.getState().awake).toBe(true);
    expect(brain.getState().lastUserText).toContain('记事本');
  });

  it('auto-wakes on a clear search need without the wake word', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('我要去巴黎的机票', true);

    expect(brain.getState().awake).toBe(true);
    expect(brain.getState().lastUserText).toContain('巴黎');
  });

  it('drops audio while asleep and plays it after waking', async () => {
    const { brain, provider, audioOut } = setup();
    await brain.start();

    provider.emitAudio(new Int16Array([1, 2, 3]));
    expect(audioOut).toHaveLength(0);

    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitAudio(new Int16Array([4, 5, 6]));
    expect(audioOut).toHaveLength(1);
  });

  it('rejects a GUI tool call for chit-chat', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '你好' },
      callId: 'call-chat',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('REJECTED');
  });

  it('redirects a pure search request from start_gui_task to search_web', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('我要去巴黎的机票', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '打开浏览器搜索去巴黎的机票' },
      callId: 'call-search-redirect',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('USE_SEARCH_WEB');
    expect(provider.toolResults[0].output).toContain('去巴黎的机票');
  });

  it('redirects site navigation from search_web to open_site', async () => {
    const { brain, provider } = setup();
    await brain.start();
    provider.emitTranscript('打开B站', true);

    provider.emitToolCall({
      name: 'search_web',
      args: { query: 'B站' },
      callId: 'call-nav-search',
    });
    await flush();

    expect(provider.toolResults[0].output).toContain('USE_OPEN_SITE');
    expect(provider.toolResults[0].output).toContain('bilibili');
  });

  it('redirects site navigation from start_gui_task to open_site', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('打开B站', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '打开B站首页' },
      callId: 'call-nav-gui',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('USE_OPEN_SITE');
  });

  it('dispatches a real GUI task and returns a task id', async () => {
    const { brain, provider, adapter, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-task',
    });
    await flush();

    expect(adapter.instruction).toBe('Open Notepad and type hello');
    expect(controller.getStatus().status).toBe('executing');
    expect(provider.toolResults[0].output).toContain('"ok":true');
    expect(provider.toolResults[0].output).toContain('task-1');
  });

  it('allows a short continuation after an earlier task request', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('我想去巴黎，最便宜的机票嘛。', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: {
        instruction:
          '打开携程，点击机票搜索，查看从当前城市到巴黎的最便宜机票。',
      },
      callId: 'call-paris',
    });
    await flush();

    expect(adapter.instruction).toContain('巴黎');
  });

  it('starts a task when the model paraphrase lacks known verbs', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript(
      '在桌面给我创建一个 TXT 文件，把《沁园春·雪》写在里面。',
      true,
    );

    provider.emitToolCall({
      name: 'start_gui_task',
      args: {
        instruction: '桌面准备一个文本文件，内容为《沁园春·雪》',
      },
      callId: 'call-create',
    });
    await flush();

    expect(adapter.instruction).toContain('桌面');
    expect(provider.toolResults[0].output).toContain('"ok":true');
  });

  it('handles stop as a control tool', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitToolCall({
      name: 'cancel_gui_task',
      args: {},
      callId: 'call-stop',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(controller.getStatus().status).toBe('cancelled');
    expect(provider.toolResults.at(-1)?.output).toContain('cancelled');
    // The tool-result response is the single acknowledgment; no proactive
    // "已停止" line should race it.
    expect(
      provider.spoken.filter((text) => text.includes('已停止')),
    ).toHaveLength(0);
  });

  it('blocks a premature completion claim while the GUI task is running', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.callbacks.onResponseStarted?.();
    provider.callbacks.onAssistantText?.("I've opened Notepad", true);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(provider.canceled).toBeGreaterThan(0);
    expect(provider.spoken.some((text) => text.includes('正在执行'))).toBe(
      true,
    );
    expect(adapter.instruction).toBe('Open Notepad and type hello');
  });

  it('cancels deterministically on "停" even without a tool call', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('算了，取消这个任务', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('cancelled');
    expect(
      provider.spoken.filter((text) => text.includes('已停止')),
    ).toHaveLength(0);
  });

  it('pauses deterministically on "暂停"', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('暂停这个任务', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('paused');
    expect(
      provider.spoken.filter((text) => text.includes('已暂停')),
    ).toHaveLength(0);
  });

  it('ignores a short self-echo transcript while the assistant is speaking', async () => {
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.callbacks.onAssistantText?.('我在呢，随时待命。', true);
    provider.emitTranscript('我在', true);
    await flush();

    expect(provider.canceled).toBeGreaterThan(0);
  });

  it('suppresses the model reply after a bare stop', async () => {
    const { brain, provider, audioOut } = setup({ requireWakeWord: false });
    await brain.start();

    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.emitTranscript('停一下', true);
    await flush();

    expect(provider.canceled).toBeGreaterThan(0);
    expect(brain.shouldSuppressReply()).toBe(true);

    const audioBefore = audioOut.length;
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.callbacks.onAssistantText?.('好的，已暂停当前任务。', true);
    await flush();

    expect(audioOut.length).toBe(audioBefore);
  });

  it('sleeps after the awake timeout', async () => {
    vi.useFakeTimers();
    const { brain, provider, wakeEvents } = setup({ awakeTimeoutMs: 1000 });
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);

    expect(brain.getState().awake).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(brain.getState().awake).toBe(false);
    expect(wakeEvents).toContain('sleep');
  });

  it('stays awake when wake word is disabled', async () => {
    vi.useFakeTimers();
    const { brain } = setup({
      requireWakeWord: false,
      awakeTimeoutMs: 0,
    });
    await brain.start();

    expect(brain.getState().awake).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(brain.getState().awake).toBe(true);
  });

  it('speaks proactive task completion', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    adapter.finish('任务完成');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(provider.spoken.some((text) => text.includes('完成'))).toBe(true);
  });

  it('starts awake when wake word is disabled', async () => {
    const { brain, provider, audioOut } = setup({ requireWakeWord: false });
    await brain.start();

    provider.emitAudio(new Int16Array([7, 8]));
    expect(brain.getState().awake).toBe(true);
    expect(audioOut).toHaveLength(1);
  });
});
