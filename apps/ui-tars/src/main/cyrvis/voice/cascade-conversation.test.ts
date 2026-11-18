import { describe, expect, it } from 'vitest';

import { shouldDisableThinking, shouldUseCascadeTools } from './cascade-policy';

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
});
