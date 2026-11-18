import { describe, expect, it } from 'vitest';

import {
  shouldDisableThinking,
  shouldSpeakAcceptedTaskDirectly,
  shouldUseCascadeTools,
} from './cascade-policy';

describe('cascade conversation routing', () => {
  it('enables tools only for operational requests', () => {
    expect(shouldUseCascadeTools('你好，介绍一下你自己')).toBe(false);
    expect(shouldUseCascadeTools('帮我打开浏览器搜索最新新闻')).toBe(true);
    expect(shouldUseCascadeTools('记住我喜欢喝乌龙茶')).toBe(true);
    expect(shouldUseCascadeTools('暂停当前任务')).toBe(true);
    expect(shouldUseCascadeTools('现在执行到哪一步了')).toBe(true);
  });

  it('disables DeepSeek thinking for lower first-token latency', () => {
    expect(
      shouldDisableThinking('https://api.deepseek.com/v1', 'deepseek-chat'),
    ).toBe(true);
    expect(
      shouldDisableThinking(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen-plus',
      ),
    ).toBe(false);
  });

  it('speaks immediately after a task is accepted without another LLM call', () => {
    expect(
      shouldSpeakAcceptedTaskDirectly({
        toolNames: ['start_gui_task'],
        rawContent: '',
        toolOutputs: [
          JSON.stringify({
            ok: true,
            task_id: 'task-1',
            status: 'started',
          }),
        ],
      }),
    ).toBe(true);
  });

  it('keeps LLM follow-up for task errors and ordinary tools', () => {
    expect(
      shouldSpeakAcceptedTaskDirectly({
        toolNames: ['start_gui_task'],
        rawContent: '',
        toolOutputs: ['TASK_BUSY: a GUI task is already running.'],
      }),
    ).toBe(false);

    expect(
      shouldSpeakAcceptedTaskDirectly({
        toolNames: ['remember_fact'],
        rawContent: '',
        toolOutputs: [JSON.stringify({ ok: true, remembered: 'tea' })],
      }),
    ).toBe(false);
  });

  it('does not duplicate speech when the model already streamed content', () => {
    expect(
      shouldSpeakAcceptedTaskDirectly({
        toolNames: ['start_gui_task'],
        rawContent: 'I will handle that.',
        toolOutputs: [JSON.stringify({ ok: true, status: 'started' })],
      }),
    ).toBe(false);
  });
});
