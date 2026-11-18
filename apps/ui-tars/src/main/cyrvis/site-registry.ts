/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Known websites for navigation requests ("打开B站", "打开淘宝搜耳机").
 * Kept electron-free so the intent classifier and tests can use it.
 */
export interface SiteEntry {
  id: string;
  label: string;
  url: string;
  aliases: string[];
  searchUrl?: (query: string) => string;
}

export const SITE_ENTRIES: SiteEntry[] = [
  {
    id: 'bilibili',
    label: 'B站',
    url: 'https://www.bilibili.com',
    aliases: ['bilibili', 'b站', '哔哩哔哩', '哔哩', 'bilibili.com'],
    searchUrl: (query) =>
      `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
  },
  {
    id: 'taobao',
    label: '淘宝',
    url: 'https://www.taobao.com',
    aliases: ['taobao', '淘宝', '淘宝网', 'taobao.com'],
    searchUrl: (query) =>
      `https://s.taobao.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    id: 'jd',
    label: '京东',
    url: 'https://www.jd.com',
    aliases: ['jd', '京东', 'jd.com'],
    searchUrl: (query) =>
      `https://search.jd.com/Search?keyword=${encodeURIComponent(query)}`,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    url: 'https://www.youtube.com',
    aliases: ['youtube', '油管', 'youtube.com'],
    searchUrl: (query) =>
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  },
  {
    id: 'zhihu',
    label: '知乎',
    url: 'https://www.zhihu.com',
    aliases: ['zhihu', '知乎', 'zhihu.com'],
    searchUrl: (query) =>
      `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
  },
  {
    id: 'weibo',
    label: '微博',
    url: 'https://weibo.com',
    aliases: ['weibo', '微博', 'weibo.com'],
    searchUrl: (query) =>
      `https://s.weibo.com/weibo?q=${encodeURIComponent(query)}`,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    url: 'https://www.xiaohongshu.com',
    aliases: ['xiaohongshu', '小红书', 'xhs', 'rednote', 'xiaohongshu.com'],
    searchUrl: (query) =>
      `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
  },
  {
    id: 'douyin',
    label: '抖音',
    url: 'https://www.douyin.com',
    aliases: ['douyin', '抖音', 'douyin.com'],
    searchUrl: (query) =>
      `https://www.douyin.com/search/${encodeURIComponent(query)}`,
  },
  {
    id: 'baidu',
    label: '百度',
    url: 'https://www.baidu.com',
    aliases: ['baidu', '百度', 'baidu.com'],
  },
  {
    id: 'google',
    label: 'Google',
    url: 'https://www.google.com',
    aliases: ['google', '谷歌', 'google.com'],
  },
  {
    id: 'bing',
    label: 'Bing',
    url: 'https://www.bing.com',
    aliases: ['bing', '必应', 'bing.com'],
  },
  {
    id: 'github',
    label: 'GitHub',
    url: 'https://github.com',
    aliases: ['github', 'github.com'],
    searchUrl: (query) =>
      `https://github.com/search?q=${encodeURIComponent(query)}`,
  },
];

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const aliasMatches = (text: string, alias: string): boolean => {
  const normalized = alias.toLowerCase();
  if (/^[a-z0-9.]+$/.test(normalized)) {
    return new RegExp(
      `(^|[^a-z0-9])${escapeRegex(normalized)}([^a-z0-9]|$)`,
      'i',
    ).test(text);
  }
  return text.includes(normalized);
};

export const resolveSite = (value: string): SiteEntry | null => {
  const input = normalize(value);
  if (!input) {
    return null;
  }
  for (const site of SITE_ENTRIES) {
    if (
      site.id === input ||
      normalize(site.label) === input ||
      site.aliases.some((alias) => normalize(alias) === input)
    ) {
      return site;
    }
    try {
      if (normalize(new URL(site.url).hostname) === input) {
        return site;
      }
    } catch {
      // The registry URLs are static; ignore malformed entries.
    }
  }
  return null;
};

export const findSiteInText = (text: string): SiteEntry | null => {
  const lower = text.toLowerCase();
  let best: { site: SiteEntry; length: number } | null = null;
  for (const site of SITE_ENTRIES) {
    for (const alias of site.aliases) {
      if (!aliasMatches(lower, alias)) {
        continue;
      }
      if (!best || alias.length > best.length) {
        best = { site, length: alias.length };
      }
    }
  }
  return best?.site ?? null;
};

export const buildSiteSearchUrl = (site: SiteEntry, query: string): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    return site.url;
  }
  if (site.searchUrl) {
    return site.searchUrl(trimmed);
  }
  const host = new URL(site.url).hostname;
  return `https://www.bing.com/search?q=${encodeURIComponent(`${trimmed} site:${host}`)}`;
};
