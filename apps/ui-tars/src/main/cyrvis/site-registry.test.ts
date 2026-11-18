/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  buildSiteSearchUrl,
  findSiteInText,
  resolveSite,
} from './site-registry';

describe('site registry', () => {
  it('resolves ids, aliases, and domains', () => {
    expect(resolveSite('B站')?.id).toBe('bilibili');
    expect(resolveSite('bilibili')?.id).toBe('bilibili');
    expect(resolveSite('bilibili.com')?.id).toBe('bilibili');
    expect(resolveSite('YouTube')?.id).toBe('youtube');
    expect(resolveSite('unknown-site')).toBeNull();
  });

  it('finds a known site in a navigation phrase', () => {
    expect(findSiteInText('打开B站')?.id).toBe('bilibili');
    expect(findSiteInText('打开淘宝买耳机')?.id).toBe('taobao');
    expect(findSiteInText('打开 YouTube 看视频')?.id).toBe('youtube');
  });

  it('does not match short ASCII aliases inside unrelated words', () => {
    expect(findSiteInText('adjust the volume')).toBeNull();
  });

  it('builds on-site search URLs', () => {
    const bilibili = resolveSite('B站');
    expect(bilibili).not.toBeNull();
    const url = buildSiteSearchUrl(bilibili!, '猫');
    expect(url).toContain('search.bilibili.com');
    expect(url).toContain('keyword=%E7%8C%AB');
  });

  it('falls back to a site-scoped Bing search', () => {
    const baidu = resolveSite('百度');
    expect(baidu).not.toBeNull();
    const url = buildSiteSearchUrl(baidu!, '天气');
    expect(url).toContain('bing.com/search');
    expect(url).toContain('site%3Awww.baidu.com');
  });
});
