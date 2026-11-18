/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  classifyVoiceIntent,
  detectSearchIntent,
  extractSearchQuery,
  isHighConfidenceSearch,
} from './search-intent';

describe('extractSearchQuery', () => {
  it.each([
    ['帮我搜索一下去巴黎的机票', '去巴黎的机票'],
    ['我要去巴黎的机票', '去巴黎的机票'],
    ['我想买一个降噪耳机', '买一个降噪耳机'],
    ['今天天气怎么样', '今天天气'],
    ['我要看看今天上海的天气', '今天上海的天气'],
    ['请帮我查一下携程和去哪儿的机票价格', '携程和去哪儿的机票价格'],
  ])('turns "%s" into "%s"', (text, expected) => {
    expect(extractSearchQuery(text)).toBe(expected);
  });
});

describe('detectSearchIntent', () => {
  it.each([
    '帮我搜索巴黎的机票',
    '我要去巴黎的机票',
    '我想买一个降噪耳机',
    '今天天气怎么样',
    '我要看看最近的新闻',
    '帮我比较一下携程和去哪儿的机票',
    '我要去巴黎',
  ])('detects a high-confidence search need: %s', (text) => {
    const decision = detectSearchIntent(text);
    expect(decision.isSearch).toBe(true);
    expect(decision.confidence).toBe('high');
    expect(decision.query.length).toBeGreaterThan(0);
    expect(isHighConfidenceSearch(text)).toBe(true);
  });

  it.each([
    ['你好', false],
    ['谢谢', false],
    ['你能做什么', false],
    ['打开记事本', false],
    ['我要打开记事本', false],
    ['帮我查一下电脑配置', false],
    ['我要写代码', false],
    ['我想听音乐', false],
    ['今天天气不错', false],
  ])('does not treat "%s" as a high-confidence search', (text) => {
    expect(isHighConfidenceSearch(text)).toBe(false);
  });

  it('keeps pointer-dependent questions out of the GUI redirect path', () => {
    const decision = detectSearchIntent('这个耳机多少钱');
    expect(decision.isSearch).toBe(true);
    expect(decision.confidence).toBe('medium');
  });

  it('treats local configuration lookups as desktop work', () => {
    const decision = detectSearchIntent('帮我查一下电脑配置');
    expect(decision.isSearch).toBe(false);
    expect(decision.reason).toContain('local');
  });
});

describe('classifyVoiceIntent', () => {
  it.each([
    ['打开bilibili', 'bilibili'],
    ['打开B站', 'bilibili'],
    ['打开淘宝', 'taobao'],
    ['打开YouTube', 'youtube'],
  ])('routes "%s" to site navigation', (text, target) => {
    const decision = classifyVoiceIntent(text);
    expect(decision.mode).toBe('navigate');
    expect(decision.target).toBe(target);
    expect(decision.targetKind).toBe('site');
  });

  it('routes app navigation separately from sites', () => {
    const decision = classifyVoiceIntent('打开VS Code');
    expect(decision.mode).toBe('navigate');
    expect(decision.target).toBe('vscode');
    expect(decision.targetKind).toBe('app');
  });

  it.each([
    ['打开B站搜一下猫', '猫', 'bilibili'],
    ['B站怎么投币', '怎么投币', 'bilibili'],
    ['给我邓小平的简介', '邓小平的简介', null],
    ['打开浏览器搜索巴黎机票', '巴黎机票', null],
  ])('routes "%s" to search with query "%s"', (text, query, target) => {
    const decision = classifyVoiceIntent(text);
    expect(decision.mode).toBe('search');
    expect(decision.query).toBe(query);
    expect(decision.target).toBe(target);
  });

  it('keeps the silent-browse flag', () => {
    const decision = classifyVoiceIntent('搜一下巴黎机票，我自己看');
    expect(decision.mode).toBe('search');
    expect(decision.query).toBe('巴黎机票');
    expect(decision.silent).toBe(true);
  });

  it('marks on-site searches separately from web answers', () => {
    expect(classifyVoiceIntent('打开B站搜一下猫').siteSearch).toBe(true);
    expect(classifyVoiceIntent('打开淘宝买耳机').siteSearch).toBe(true);
    expect(classifyVoiceIntent('B站怎么投币').siteSearch).toBeFalsy();
    expect(classifyVoiceIntent('给我邓小平的简介').siteSearch).toBeFalsy();
  });

  it('treats bare search/browser navigation as navigation', () => {
    const decision = classifyVoiceIntent('打开搜索，我自己看');
    expect(decision.mode).toBe('navigate');
    expect(decision.target).toBe('bing');
    expect(decision.silent).toBe(true);
  });

  it('routes comparison and transaction intents', () => {
    expect(classifyVoiceIntent('帮我比较携程和去哪儿的价格').mode).toBe(
      'compare',
    );
    expect(classifyVoiceIntent('打开淘宝买耳机').mode).toBe('search');
    expect(classifyVoiceIntent('打开记事本输入 Hello').mode).toBe('task');
  });

  it('marks pointer-only requests as ambiguous', () => {
    expect(classifyVoiceIntent('打开这个视频').mode).toBe('ambiguous');
    expect(classifyVoiceIntent('这个多少钱').mode).toBe('ambiguous');
  });
});
