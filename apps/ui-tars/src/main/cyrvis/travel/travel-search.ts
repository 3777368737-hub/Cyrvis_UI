/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  TravelFramework,
  TravelAspect,
  TravelHighlight,
  TravelInterest,
} from './travel-planner';
import { INTEREST_LABEL, INTEREST_ORDER, aspectLabel } from './travel-planner';
import { buildSeasonContext } from './travel-season';

export interface TravelSearchHit {
  title: string;
  url?: string;
  snippet?: string;
}

export interface TravelSearchResult {
  query: string;
  hits: TravelSearchHit[];
  ok: boolean;
  error?: string;
}

export const buildTravelSearchQuery = (
  framework: TravelFramework,
  aspect?: TravelAspect | null,
  extra?: string,
): string => {
  const season = buildSeasonContext(framework.startDate, framework.endDate);
  const parts = [
    framework.origin,
    framework.destination,
    framework.startDate,
    framework.endDate,
    season.queryExtra,
    framework.transport || '旅行',
    aspect ? aspectLabel(aspect) : '',
    extra || '',
  ]
    .map((part) => (part || '').trim())
    .filter(Boolean);
  return parts.join(' ');
};

const collectRelated = (
  node: unknown,
  hits: TravelSearchHit[],
  limit: number,
): void => {
  if (!node || hits.length >= limit) return;
  if (Array.isArray(node)) {
    for (const item of node) collectRelated(item, hits, limit);
    return;
  }
  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.Text === 'string' && record.Text.trim()) {
    hits.push({
      title: record.Text.trim().slice(0, 120),
      url: typeof record.FirstURL === 'string' ? record.FirstURL : undefined,
      snippet:
        typeof record.Result === 'string'
          ? record.Result.replace(/<[^>]+>/g, '').slice(0, 160)
          : undefined,
    });
  }
  if (record.Topics) collectRelated(record.Topics, hits, limit);
};

/**
 * Lightweight web search for travel planning. Uses DuckDuckGo Instant Answer
 * JSON (no extra dependency). Flight prices are often missing here; callers
 * should treat hits as research hints, not booking truth.
 */
export const searchTravelInfo = async (
  query: string,
  limit = 5,
): Promise<TravelSearchResult> => {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: '', hits: [], ok: false, error: 'empty query' };
  }

  const controller = new AbortController();
  // Keep travel search snappy; Instant Answer rarely helps CN booking links.
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(trimmed)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return {
        query: trimmed,
        hits: [],
        ok: false,
        error: `http ${response.status}`,
      };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const hits: TravelSearchHit[] = [];
    if (typeof data.AbstractText === 'string' && data.AbstractText.trim()) {
      hits.push({
        title:
          typeof data.Heading === 'string' && data.Heading.trim()
            ? data.Heading.trim()
            : trimmed,
        url:
          typeof data.AbstractURL === 'string' ? data.AbstractURL : undefined,
        snippet: data.AbstractText.trim().slice(0, 180),
      });
    }
    collectRelated(data.RelatedTopics, hits, limit);
    return { query: trimmed, hits: hits.slice(0, limit), ok: true };
  } catch (error) {
    return {
      query: trimmed,
      hits: [],
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

export const hitsToSnippets = (hits: TravelSearchHit[]): string[] =>
  hits.map((hit) => {
    const body = hit.snippet || hit.title;
    return hit.url ? `${body} (${hit.url})` : body;
  });

const INTEREST_QUERY_HINT: Record<TravelInterest, string> = {
  food: '美食 特色菜 必吃',
  checkin: '网红打卡 拍照 出片',
  landmark: '必去景点 经典地标',
  experience: '当地特色体验 市集',
};

export const buildInterestSearchQuery = (
  framework: TravelFramework,
  interest: TravelInterest,
): string => {
  const season = buildSeasonContext(framework.startDate, framework.endDate);
  return [
    framework.destination,
    framework.startDate,
    season.monthLabel,
    season.seasonHint,
    ...season.festivalHints.slice(0, 2),
    INTEREST_QUERY_HINT[interest],
    framework.companions,
  ]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' ');
};

/**
 * One lightweight search per major interest category. Keep results coarse:
 * the planner only needs a single highlight title per category.
 */
export const probeTravelHighlights = async (
  framework: TravelFramework,
): Promise<{
  highlights: TravelHighlight[];
  queries: string[];
  errors: string[];
  season: ReturnType<typeof buildSeasonContext>;
}> => {
  const highlights: TravelHighlight[] = [];
  const queries: string[] = [];
  const errors: string[] = [];
  const season = buildSeasonContext(framework.startDate, framework.endDate);

  const settled = await Promise.all(
    INTEREST_ORDER.map(async (interest) => {
      const query = buildInterestSearchQuery(framework, interest);
      const result = await searchTravelInfo(query, 3);
      return { interest, query, result };
    }),
  );

  for (const row of settled) {
    queries.push(row.query);
    if (!row.result.ok && row.result.error) {
      errors.push(`${row.interest}:${row.result.error}`);
    }
    const top = row.result.hits[0];
    if (top?.title) {
      highlights.push({
        interest: row.interest,
        title: top.title.slice(0, 80),
        detail: (top.snippet || INTEREST_LABEL[row.interest]).slice(0, 100),
      });
    } else {
      // Fallback stub so probing still works offline / empty search.
      highlights.push({
        interest: row.interest,
        title: `${framework.destination || '当地'}${season.monthLabel || ''}${INTEREST_LABEL[row.interest]}`,
        detail: season.festivalHints[0]
          ? `${season.festivalHints[0]}时节参考`
          : '检索暂无结果，先用类别占位，可再细查',
      });
    }
  }

  return { highlights, queries, errors, season };
};
