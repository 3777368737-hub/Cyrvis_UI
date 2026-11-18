/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  buildCtripFlightUrl,
  buildFliggyFlightUrl,
  buildQunarFlightUrl,
  recommendTravelOffers,
  resolveCityCode,
  travelSearch,
  type TravelOffer,
  type TravelQuery,
} from './travel-search';

const query: TravelQuery = {
  vertical: 'flight',
  origin: '上海',
  destination: '巴黎',
  departDate: '2026-12-01',
  adults: 1,
};

const offer = (overrides: Partial<TravelOffer>): TravelOffer => ({
  site: 'ctrip',
  siteLabel: '携程',
  title: '上海 -> 巴黎',
  price: null,
  currency: 'CNY',
  url: 'https://example.com',
  capturedAt: 0,
  ...overrides,
});

describe('travel search adapters', () => {
  it('resolves Chinese city names and IATA codes', () => {
    expect(resolveCityCode('上海')).toBe('SHA');
    expect(resolveCityCode('上海市')).toBe('SHA');
    expect(resolveCityCode('par')).toBe('PAR');
    expect(() => resolveCityCode('不存在的城市')).toThrow('unknown city');
  });

  it('builds a Ctrip one-way flight URL', () => {
    const url = buildCtripFlightUrl(query);
    expect(url).toContain('oneway-SHA-PAR');
    expect(url).toContain('depdate=2026-12-01');
    expect(url).toContain('adult=1');
  });

  it('builds a Ctrip round-trip URL', () => {
    const url = buildCtripFlightUrl({
      ...query,
      returnDate: '2026-12-08',
    });
    expect(url).toContain('round-SHA-PAR');
    expect(url).toContain('returndate=2026-12-08');
  });

  it('builds Qunar and Fliggy URLs with the resolved codes', () => {
    const qunar = buildQunarFlightUrl(query);
    expect(qunar).toContain('fromCode=SHA');
    expect(qunar).toContain('toCode=PAR');
    expect(qunar).toContain('searchDepartureTime=2026-12-01');

    const fliggy = buildFliggyFlightUrl(query);
    expect(fliggy).toContain('depCity=%E4%B8%8A%E6%B5%B7');
    expect(fliggy).toContain('arrCity=%E5%B7%B4%E9%BB%8E');
  });

  it('rejects an invalid date', () => {
    expect(() =>
      buildCtripFlightUrl({ ...query, departDate: '2026-02-31' }),
    ).toThrow('invalid departDate');
  });

  it('reports unimplemented site adapters instead of throwing', async () => {
    const result = await travelSearch(query);
    expect(result.offers).toHaveLength(0);
    expect(result.errors.map((error) => error.site).sort()).toEqual([
      'ctrip',
      'fliggy',
      'qunar',
    ]);
    expect(result.errors[0].message).toContain('not implemented');
  });
});

describe('recommendTravelOffers', () => {
  it('picks the cheapest and the fastest offer', () => {
    const result = recommendTravelOffers([
      offer({
        site: 'ctrip',
        siteLabel: '携程',
        price: 5500,
        durationMinutes: 720,
      }),
      offer({
        site: 'qunar',
        siteLabel: '去哪儿',
        price: 4500,
        durationMinutes: 780,
      }),
    ]);

    expect(result.cheapest?.site).toBe('qunar');
    expect(result.fastest?.site).toBe('ctrip');
    expect(result.summary).toContain('最低价');
    expect(result.summary).toContain('最快');
  });

  it('handles an empty offer list', () => {
    expect(recommendTravelOffers([]).summary).toContain('没有拿到');
  });
});
