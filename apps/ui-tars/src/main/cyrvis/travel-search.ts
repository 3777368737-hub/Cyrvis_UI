/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-site travel search skeleton.
 *
 * The voice layer will eventually expose this as `travel_search`. The flow is:
 *   query parser -> site adapters (parallel) -> structured offers -> LLM ranker
 *
 * `buildSearchUrl` is implemented now so adapters can be verified without a
 * browser. `search` stays unimplemented until the hidden-browser worker lands;
 * `travelSearch` reports those failures instead of throwing.
 */

export type TravelVertical = 'flight' | 'hotel' | 'train';
export type TravelSiteId = 'ctrip' | 'qunar' | 'fliggy';

export interface TravelQuery {
  vertical: TravelVertical;
  origin?: string;
  destination?: string;
  /** ISO date: YYYY-MM-DD. */
  departDate?: string;
  /** ISO date: YYYY-MM-DD. */
  returnDate?: string;
  adults?: number;
  children?: number;
}

export interface TravelOffer {
  site: TravelSiteId;
  siteLabel: string;
  title: string;
  price: number | null;
  currency: string;
  airline?: string;
  departureTime?: string;
  arrivalTime?: string;
  durationMinutes?: number;
  stops?: number;
  url: string;
  capturedAt: number;
}

export interface TravelSiteError {
  site: TravelSiteId;
  message: string;
}

export interface TravelSearchResult {
  query: TravelQuery;
  offers: TravelOffer[];
  errors: TravelSiteError[];
  searchedAt: number;
}

export interface TravelRecommendation {
  cheapest?: TravelOffer;
  fastest?: TravelOffer;
  bestValue?: TravelOffer;
  summary: string;
}

export interface TravelSiteAdapter {
  id: TravelSiteId;
  label: string;
  supports(vertical: TravelVertical): boolean;
  buildSearchUrl(query: TravelQuery): string;
  /** Implemented by the hidden-browser worker in a later iteration. */
  search(query: TravelQuery): Promise<TravelOffer[]>;
}

const CITY_CODES: Record<string, string> = {
  上海: 'SHA',
  北京: 'BJS',
  广州: 'CAN',
  深圳: 'SZX',
  成都: 'CTU',
  重庆: 'CKG',
  杭州: 'HGH',
  南京: 'NKG',
  武汉: 'WUH',
  西安: 'SIA',
  昆明: 'KMG',
  厦门: 'XMN',
  青岛: 'TAO',
  天津: 'TSN',
  长沙: 'CSX',
  郑州: 'CGO',
  济南: 'TNA',
  福州: 'FOC',
  大连: 'DLC',
  沈阳: 'SHE',
  哈尔滨: 'HRB',
  乌鲁木齐: 'URC',
  海口: 'HAK',
  三亚: 'SYX',
  香港: 'HKG',
  澳门: 'MFM',
  台北: 'TPE',
  东京: 'TYO',
  大阪: 'OSA',
  首尔: 'SEL',
  新加坡: 'SIN',
  曼谷: 'BKK',
  吉隆坡: 'KUL',
  马尼拉: 'MNL',
  雅加达: 'JKT',
  胡志明市: 'SGN',
  河内: 'HAN',
  巴黎: 'PAR',
  伦敦: 'LON',
  罗马: 'ROM',
  米兰: 'MIL',
  马德里: 'MAD',
  巴塞罗那: 'BCN',
  阿姆斯特丹: 'AMS',
  法兰克福: 'FRA',
  慕尼黑: 'MUC',
  柏林: 'BER',
  苏黎世: 'ZRH',
  日内瓦: 'GVA',
  维也纳: 'VIE',
  布拉格: 'PRG',
  纽约: 'NYC',
  洛杉矶: 'LAX',
  旧金山: 'SFO',
  西雅图: 'SEA',
  芝加哥: 'CHI',
  波士顿: 'BOS',
  华盛顿: 'WAS',
  迈阿密: 'MIA',
  拉斯维加斯: 'LAS',
  温哥华: 'YVR',
  多伦多: 'YTO',
  悉尼: 'SYD',
  墨尔本: 'MEL',
  奥克兰: 'AKL',
  迪拜: 'DXB',
  多哈: 'DOH',
  伊斯坦布尔: 'IST',
  莫斯科: 'MOW',
  圣彼得堡: 'LED',
};

const normalizeCity = (value: string): string =>
  value.trim().replace(/市$/, '');

export const resolveCityCode = (value: string): string => {
  const normalized = normalizeCity(value);
  if (!normalized) {
    throw new Error('city is empty');
  }
  if (/^[A-Za-z]{3}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  const code = CITY_CODES[normalized];
  if (!code) {
    throw new Error(
      `unknown city "${value}"; use a 3-letter airport/city code or add it to CITY_CODES`,
    );
  }
  return code;
};

const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const boundedCount = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(9, Math.floor(value as number)));
};

const requireFlightQuery = (query: TravelQuery) => {
  if (query.vertical !== 'flight') {
    throw new Error(`unsupported travel vertical: ${query.vertical}`);
  }
  const origin = query.origin?.trim();
  const destination = query.destination?.trim();
  const departDate = query.departDate?.trim();
  if (!origin || !destination || !departDate) {
    throw new Error(
      'flight search requires origin, destination, and departDate',
    );
  }
  if (!isIsoDate(departDate)) {
    throw new Error(`invalid departDate: ${departDate}`);
  }
  if (query.returnDate && !isIsoDate(query.returnDate)) {
    throw new Error(`invalid returnDate: ${query.returnDate}`);
  }
  return {
    origin,
    destination,
    originCode: resolveCityCode(origin),
    destinationCode: resolveCityCode(destination),
    departDate,
    returnDate: query.returnDate?.trim() || undefined,
    adults: Math.max(1, boundedCount(query.adults, 1)),
    children: boundedCount(query.children, 0),
  };
};

export const buildCtripFlightUrl = (query: TravelQuery): string => {
  const q = requireFlightQuery(query);
  const trip = q.returnDate ? 'round' : 'oneway';
  const params = new URLSearchParams({
    depdate: q.departDate,
    cabin: 'y_s',
    adult: String(q.adults),
    child: String(q.children),
    infant: '0',
  });
  if (q.returnDate) {
    params.set('returndate', q.returnDate);
  }
  return `https://flights.ctrip.com/online/list/${trip}-${q.originCode}-${q.destinationCode}?${params.toString()}`;
};

export const buildQunarFlightUrl = (query: TravelQuery): string => {
  const q = requireFlightQuery(query);
  // Qunar resolves city names directly; codes are also passed for precision.
  const params = new URLSearchParams({
    searchDepartureAirport: q.origin,
    searchArrivalAirport: q.destination,
    searchDepartureTime: q.departDate,
    startSearch: 'true',
    fromCode: q.originCode,
    toCode: q.destinationCode,
    adultNum: String(q.adults),
    childNum: String(q.children),
  });
  if (q.returnDate) {
    params.set('searchReturnTime', q.returnDate);
    params.set('tripType', 'round');
  }
  return `https://flight.qunar.com/site/oneway_list.htm?${params.toString()}`;
};

export const buildFliggyFlightUrl = (query: TravelQuery): string => {
  const q = requireFlightQuery(query);
  const params = new URLSearchParams({
    tripType: q.returnDate ? '1' : '0',
    depCity: q.origin,
    arrCity: q.destination,
    depDate: q.departDate,
    adultNum: String(q.adults),
    childNum: String(q.children),
  });
  if (q.returnDate) {
    params.set('retDate', q.returnDate);
  }
  // TODO: verify this URL against the live Fliggy flight search page.
  return `https://sjipiao.fliggy.com/flight_search_result.htm?${params.toString()}`;
};

const notImplementedSearch = async (): Promise<TravelOffer[]> => {
  throw new Error(
    'adapter search is not implemented; hidden-browser extraction comes next',
  );
};

export const TRAVEL_SITE_ADAPTERS: TravelSiteAdapter[] = [
  {
    id: 'ctrip',
    label: '携程',
    supports: (vertical) => vertical === 'flight',
    buildSearchUrl: buildCtripFlightUrl,
    search: notImplementedSearch,
  },
  {
    id: 'qunar',
    label: '去哪儿',
    supports: (vertical) => vertical === 'flight',
    buildSearchUrl: buildQunarFlightUrl,
    search: notImplementedSearch,
  },
  {
    id: 'fliggy',
    label: '飞猪',
    supports: (vertical) => vertical === 'flight',
    buildSearchUrl: buildFliggyFlightUrl,
    search: notImplementedSearch,
  },
];

export const travelSearch = async (
  query: TravelQuery,
  adapters: TravelSiteAdapter[] = TRAVEL_SITE_ADAPTERS,
): Promise<TravelSearchResult> => {
  const offers: TravelOffer[] = [];
  const errors: TravelSiteError[] = [];

  await Promise.all(
    adapters
      .filter((adapter) => adapter.supports(query.vertical))
      .map(async (adapter) => {
        try {
          const siteOffers = await adapter.search(query);
          offers.push(...siteOffers);
        } catch (error) {
          errors.push({
            site: adapter.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
  );

  return {
    query,
    offers,
    errors,
    searchedAt: Date.now(),
  };
};

const validPrice = (offer: TravelOffer): number | null =>
  typeof offer.price === 'number' && Number.isFinite(offer.price)
    ? offer.price
    : null;

const validDuration = (offer: TravelOffer): number | null =>
  typeof offer.durationMinutes === 'number' &&
  Number.isFinite(offer.durationMinutes)
    ? offer.durationMinutes
    : null;

const minBy = (
  offers: TravelOffer[],
  value: (offer: TravelOffer) => number | null,
): TravelOffer | undefined => {
  let best: TravelOffer | undefined;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const offer of offers) {
    const candidate = value(offer);
    if (candidate !== null && candidate < bestValue) {
      best = offer;
      bestValue = candidate;
    }
  }
  return best;
};

const formatOffer = (offer: TravelOffer): string => {
  const price = validPrice(offer);
  return price === null
    ? `${offer.siteLabel} ${offer.title}`
    : `${offer.siteLabel} ${price} 元`;
};

/**
 * Deterministic first pass. The LLM can still re-rank with airline, baggage,
 * and user preferences once real offers are available.
 */
export const recommendTravelOffers = (
  offers: TravelOffer[],
): TravelRecommendation => {
  if (!offers.length) {
    return { summary: '没有拿到可比较的报价。' };
  }

  const cheapest = minBy(offers, validPrice);
  const fastest = minBy(offers, validDuration);

  const priceBase = cheapest ? validPrice(cheapest) : null;
  const durationBase = fastest ? validDuration(fastest) : null;
  const score = (offer: TravelOffer): number | null => {
    const price = validPrice(offer);
    const duration = validDuration(offer);
    if (price === null || duration === null) {
      return null;
    }
    return (
      (priceBase ? price / priceBase : 0) +
      (durationBase ? duration / durationBase : 0)
    );
  };
  const bestValue = minBy(offers, score);

  const parts: string[] = [`共 ${offers.length} 个报价`];
  if (cheapest) {
    parts.push(`最低价 ${formatOffer(cheapest)}`);
  }
  if (fastest && fastest !== cheapest) {
    const duration = validDuration(fastest);
    parts.push(
      duration === null
        ? `最快 ${formatOffer(fastest)}`
        : `最快 ${Math.round(duration)} 分钟（${formatOffer(fastest)}）`,
    );
  }
  if (bestValue && bestValue !== cheapest && bestValue !== fastest) {
    parts.push(`综合推荐 ${formatOffer(bestValue)}`);
  }

  return {
    cheapest,
    fastest,
    bestValue,
    summary: `${parts.join('；')}。`,
  };
};
