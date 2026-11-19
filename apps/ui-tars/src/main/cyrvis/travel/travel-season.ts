/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TravelSeasonContext {
  month?: number;
  monthLabel?: string;
  seasonHint?: string;
  festivalHints: string[];
  queryExtra: string;
}

const MONTH_LABELS = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
];

const FESTIVAL_BY_MONTH: Record<number, string[]> = {
  1: ['新年', '元旦'],
  2: ['春节前后', '情人节'],
  3: ['春季', '妇女节出行'],
  4: ['清明小长假', '复活节假期'],
  5: ['五一劳动节', '初夏'],
  6: ['端午节', '毕业季旅行'],
  7: ['暑假', '盛夏'],
  8: ['暑假尾声', '盛夏'],
  9: ['开学季', '中秋前后'],
  10: ['国庆黄金周', '秋季'],
  11: ['深秋', '购物季预热'],
  12: ['圣诞季', '跨年', '圣诞市场'],
};

const CN_MONTH: Record<string, number> = {
  一月: 1,
  二月: 2,
  三月: 3,
  四月: 4,
  五月: 5,
  六月: 6,
  七月: 7,
  八月: 8,
  九月: 9,
  十月: 10,
  十一月: 11,
  十二月: 12,
  '1月': 1,
  '2月': 2,
  '3月': 3,
  '4月': 4,
  '5月': 5,
  '6月': 6,
  '7月': 7,
  '8月': 8,
  '9月': 9,
  '10月': 10,
  '11月': 11,
  '12月': 12,
};

/** Infer month from free-form date text; fallback to current month. */
export const inferTravelMonth = (
  startDate?: string,
  endDate?: string,
  now = new Date(),
): number => {
  const text = `${startDate || ''} ${endDate || ''}`;
  // Prefer explicit numeric month with word boundary so "12月" is not
  // misread as "2月".
  const numeric = text.match(/(?:^|[^\d])(1[0-2]|[1-9])\s*月/);
  if (numeric) return Number(numeric[1]);
  const cnLabels = [
    '十一月',
    '十二月',
    '十月',
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
  ];
  for (const label of cnLabels) {
    if (text.includes(label) && CN_MONTH[label]) return CN_MONTH[label];
  }
  if (/下下周|下周|这周|周末/.test(text)) return now.getMonth() + 1;
  if (/寒假|过年|春节|元旦/.test(text)) return 1;
  if (/暑假/.test(text)) return 7;
  if (/国庆/.test(text)) return 10;
  if (/圣诞|跨年/.test(text)) return 12;
  if (/五一/.test(text)) return 5;
  if (/中秋/.test(text)) return 9;
  return now.getMonth() + 1;
};

export const buildSeasonContext = (
  startDate?: string,
  endDate?: string,
  now = new Date(),
): TravelSeasonContext => {
  const month = inferTravelMonth(startDate, endDate, now);
  const monthLabel = MONTH_LABELS[month - 1];
  const festivalHints = FESTIVAL_BY_MONTH[month] || [];
  const seasonHint =
    month <= 2 || month === 12
      ? '冬季'
      : month <= 5
        ? '春季'
        : month <= 8
          ? '夏季'
          : '秋季';
  const queryExtra = [monthLabel, seasonHint, ...festivalHints.slice(0, 2)]
    .filter(Boolean)
    .join(' ');
  return {
    month,
    monthLabel,
    seasonHint,
    festivalHints,
    queryExtra,
  };
};
