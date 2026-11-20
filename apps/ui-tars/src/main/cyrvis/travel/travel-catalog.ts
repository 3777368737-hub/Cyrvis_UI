/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TravelAspect, TravelInterest } from './travel-planner';

export type CatalogKind = 'stay' | 'food' | 'sight' | 'ticket' | 'area';

export interface CatalogPlace {
  id: string;
  name: string;
  kind: CatalogKind;
  area: string;
  /** Destination keys this entry belongs to (matched loosely). */
  destinations: string[];
  tags: Array<TravelInterest | 'ski' | 'relax'>;
  blurb: string;
  /** Official or booking page — speak/write the link; never auto-book in GUI. */
  url?: string;
  /** Optional nearby companion place id. */
  pairWith?: string;
}

/** Real booking / official deep links — never Bing/search intermediaries. */
const enc = (text: string): string => encodeURIComponent(text.trim());

export const bookingHotelSearchUrl = (query: string): string =>
  `https://www.booking.com/searchresults.html?ss=${enc(query)}`;

export const tripHotelSearchUrl = (dest: string): string =>
  `https://www.trip.com/hotels/list?keyword=${enc(dest)}`;

export const ctripHotelSearchUrl = (dest: string): string =>
  `https://hotels.ctrip.com/hotels/list?keyword=${enc(dest)}`;

export const tripAttractionSearchUrl = (dest: string): string =>
  `https://www.trip.com/things-to-do/list?keyword=${enc(dest)}`;

export const ctripTicketSearchUrl = (dest: string): string =>
  `https://you.ctrip.com/globalsearch/site/search?keyword=${enc(`${dest} 门票`)}`;

export const damaiSearchUrl = (dest: string): string =>
  `https://search.damai.cn/search.htm?keyword=${enc(dest)}`;

/** Curated demo seeds — prefer these over live Instant Answer search. */
export const TRAVEL_CATALOG: CatalogPlace[] = [
  // Paris
  {
    id: 'paris-stay-latin',
    name: '拉丁区精品酒店（可免费取消）',
    kind: 'stay',
    area: '拉丁区',
    destinations: ['巴黎', 'paris'],
    tags: ['food', 'landmark'],
    blurb: '步行可达餐厅与塞纳河',
    url: bookingHotelSearchUrl('Latin Quarter, Paris'),
  },
  {
    id: 'paris-stay-marais',
    name: '马莱区设计公寓',
    kind: 'stay',
    area: '马莱区',
    destinations: ['巴黎', 'paris'],
    tags: ['checkin', 'food'],
    blurb: '出片街巷多、晚饭选择密',
    url: bookingHotelSearchUrl('Le Marais, Paris'),
  },
  {
    id: 'paris-stay-stgermain',
    name: '圣日耳曼旁三星酒店',
    kind: 'stay',
    area: '圣日耳曼',
    destinations: ['巴黎', 'paris'],
    tags: ['landmark', 'experience'],
    blurb: '地铁方便、不赶早也好出门',
    url: tripHotelSearchUrl('Saint-Germain-des-Prés Paris'),
  },
  {
    id: 'paris-food-comptoir',
    name: 'Le Comptoir 法式小馆',
    kind: 'food',
    area: '圣日耳曼',
    destinations: ['巴黎', 'paris'],
    tags: ['food'],
    blurb: '经典法餐，建议提前订位',
  },
  {
    id: 'paris-food-marais-cafe',
    name: '马莱区咖啡馆+可丽饼',
    kind: 'food',
    area: '马莱区',
    destinations: ['巴黎', 'paris'],
    tags: ['food', 'checkin'],
    blurb: '轻食补能，适合散步间隙',
  },
  {
    id: 'paris-sight-louvre',
    name: '卢浮宫（预约场次）',
    kind: 'sight',
    area: '卢浮宫周边',
    destinations: ['巴黎', 'paris'],
    tags: ['landmark'],
    blurb: '经典必去，错峰午后更轻松',
    url: 'https://www.louvre.fr/',
  },
  {
    id: 'paris-sight-sacre',
    name: '圣心堂阶梯打卡',
    kind: 'sight',
    area: '蒙马特',
    destinations: ['巴黎', 'paris'],
    tags: ['checkin'],
    blurb: '黄昏光线好，少爬坡选缆车',
    url: 'https://www.sacre-coeur-montmartre.com/',
  },
  {
    id: 'paris-sight-seine',
    name: '塞纳河黄昏游船',
    kind: 'sight',
    area: '塞纳河',
    destinations: ['巴黎', 'paris'],
    tags: ['experience', 'checkin'],
    blurb: '坐船少走路，适合轻松夜',
    url: 'https://www.bateauxparisiens.com/',
  },
  {
    id: 'paris-ticket-louvre',
    name: '卢浮宫官方时段票',
    kind: 'ticket',
    area: '卢浮宫周边',
    destinations: ['巴黎', 'paris'],
    tags: ['landmark'],
    blurb: '先锁预约窗口，避免裸排',
    url: 'https://www.ticketlouvre.fr/',
  },
  {
    id: 'paris-ticket-tower',
    name: '埃菲尔铁塔楼梯/电梯票',
    kind: 'ticket',
    area: '七区',
    destinations: ['巴黎', 'paris'],
    tags: ['landmark', 'checkin'],
    blurb: '热门票，能约就约',
    url: 'https://www.toureiffel.paris/',
  },
  // Chongli / ski
  {
    id: 'chongli-stay-thaiwoo',
    name: '太舞小镇滑雪酒店',
    kind: 'stay',
    area: '太舞',
    destinations: ['崇礼', '太舞', '张家口', '滑雪'],
    tags: ['ski', 'relax'],
    blurb: '住雪场边，少通勤',
    url: 'https://www.thaiwoo.com/',
  },
  {
    id: 'chongli-stay-genting',
    name: '云顶大酒店（雪具寄存方便）',
    kind: 'stay',
    area: '云顶',
    destinations: ['崇礼', '云顶', '张家口', '滑雪'],
    tags: ['ski'],
    blurb: '缆车近，适合早场雪',
    url: 'https://www.gentingresort.com.cn/',
  },
  {
    id: 'chongli-ticket-day',
    name: '太舞日场雪票（含缆车）',
    kind: 'ticket',
    area: '太舞',
    destinations: ['崇礼', '太舞', '张家口', '滑雪'],
    tags: ['ski'],
    blurb: '官网/官方渠道先锁定日期',
    url: 'https://www.thaiwoo.com/',
  },
  {
    id: 'chongli-ticket-half',
    name: '云顶下午场雪票',
    kind: 'ticket',
    area: '云顶',
    destinations: ['崇礼', '云顶', '张家口', '滑雪'],
    tags: ['ski', 'relax'],
    blurb: '不赶早，下午滑更轻松',
    url: 'https://www.gentingresort.com.cn/',
  },
  {
    id: 'chongli-ticket-rental',
    name: '雪具租赁套餐（板靴盔）',
    kind: 'ticket',
    area: '太舞',
    destinations: ['崇礼', '太舞', '张家口', '滑雪'],
    tags: ['ski'],
    blurb: '和雪票同一渠道一起订',
    url: 'https://www.thaiwoo.com/',
  },
  {
    id: 'chongli-food-hotpot',
    name: '雪场附近涮肉/火锅',
    kind: 'food',
    area: '太舞',
    destinations: ['崇礼', '太舞', '张家口', '滑雪'],
    tags: ['food', 'ski', 'relax'],
    blurb: '滑完补热量，走路少',
  },
  {
    id: 'chongli-sight-night',
    name: '小镇夜景散步+温泉备选',
    kind: 'sight',
    area: '太舞',
    destinations: ['崇礼', '太舞', '张家口', '滑雪'],
    tags: ['relax', 'experience'],
    blurb: '第二天不累可换温泉',
  },
  // Beijing — concrete executable spots
  {
    id: 'bj-sight-gugong',
    name: '故宫博物院',
    kind: 'sight',
    area: '东城区',
    destinations: ['北京', 'beijing'],
    tags: ['landmark'],
    blurb: '建议早场预约，少排队',
    url: 'https://ticket.dpm.org.cn/',
  },
  {
    id: 'bj-ticket-gugong',
    name: '故宫门票（官网预约）',
    kind: 'ticket',
    area: '东城区',
    destinations: ['北京', 'beijing'],
    tags: ['landmark'],
    blurb: '实名预约，选上午场更轻松',
    url: 'https://ticket.dpm.org.cn/',
  },
  {
    id: 'bj-sight-sanlitun',
    name: '三里屯太古里',
    kind: 'sight',
    area: '朝阳区',
    destinations: ['北京', 'beijing'],
    tags: ['checkin', 'food', 'experience'],
    blurb: '下午逛街打卡，晚上可转酒吧',
  },
  {
    id: 'bj-food-sanlitun',
    name: '三里屯一带餐厅（日料/创意菜）',
    kind: 'food',
    area: '朝阳区',
    destinations: ['北京', 'beijing'],
    tags: ['food', 'checkin'],
    blurb: '和打卡点同区域，少跑路',
  },
  {
    id: 'bj-sight-nanluogu',
    name: '南锣鼓巷+景山公园远眺',
    kind: 'sight',
    area: '东城区',
    destinations: ['北京', 'beijing'],
    tags: ['checkin', 'landmark'],
    blurb: '胡同出片，傍晚光线好',
  },
  {
    id: 'bj-food-guijie',
    name: '簋街夜宵小龙虾',
    kind: 'food',
    area: '东城区',
    destinations: ['北京', 'beijing'],
    tags: ['food', 'experience'],
    blurb: '晚间氛围足，适合打卡党',
  },
  {
    id: 'bj-sight-798',
    name: '798艺术区',
    kind: 'sight',
    area: '朝阳区',
    destinations: ['北京', 'beijing'],
    tags: ['checkin', 'experience'],
    blurb: '展馆+街拍，不赶早也合适',
  },
  {
    id: 'bj-sight-shichahai',
    name: '什刹海酒吧街散步',
    kind: 'sight',
    area: '西城区',
    destinations: ['北京', 'beijing'],
    tags: ['experience', 'checkin', 'relax'],
    blurb: '想喝酒就留下来，不想就只散步',
  },
  {
    id: 'bj-stay-dongcheng',
    name: '东城区地铁旁酒店（可免费取消）',
    kind: 'stay',
    area: '东城区',
    destinations: ['北京', 'beijing'],
    tags: ['landmark', 'checkin'],
    blurb: '去故宫/南锣都近',
    url: bookingHotelSearchUrl('Beijing Dongcheng'),
  },
  {
    id: 'bj-stay-chaoyang',
    name: '三里屯/工体附近酒店',
    kind: 'stay',
    area: '朝阳区',
    destinations: ['北京', 'beijing'],
    tags: ['checkin', 'food', 'experience'],
    blurb: '夜生活方便，适合打卡线',
    url: bookingHotelSearchUrl('Sanlitun Beijing'),
  },
  // Foshan
  {
    id: 'fs-sight-zumiao',
    name: '佛山祖庙',
    kind: 'sight',
    area: '禅城区',
    destinations: ['佛山', 'foshan'],
    tags: ['landmark'],
    blurb: '经典必去，半日足够',
  },
  {
    id: 'fs-sight-lingnan',
    name: '岭南天地',
    kind: 'sight',
    area: '禅城区',
    destinations: ['佛山', 'foshan'],
    tags: ['checkin', 'food', 'experience'],
    blurb: '逛街+夜景出片',
  },
  {
    id: 'fs-food-shunde-lunch',
    name: '顺德凤城食街（焯猪杂/鱼生）',
    kind: 'food',
    area: '顺德',
    destinations: ['佛山', 'foshan', '顺德'],
    tags: ['food'],
    blurb: '正餐主线，本地人气食街',
  },
  {
    id: 'fs-food-shuangpinai',
    name: '民信老铺双皮奶',
    kind: 'food',
    area: '顺德',
    destinations: ['佛山', 'foshan', '顺德'],
    tags: ['food', 'checkin'],
    blurb: '饭后甜品打卡',
  },
  {
    id: 'fs-food-zaocha',
    name: '禅城早茶（点心+虾饺）',
    kind: 'food',
    area: '禅城区',
    destinations: ['佛山', 'foshan'],
    tags: ['food', 'relax'],
    blurb: '偏晚出门也合适',
  },
  {
    id: 'fs-sight-qinghui',
    name: '清晖园',
    kind: 'sight',
    area: '顺德',
    destinations: ['佛山', 'foshan', '顺德'],
    tags: ['landmark', 'relax', 'food'],
    blurb: '园林散步，吃完顺路逛',
  },
  {
    id: 'fs-sight-nanfeng',
    name: '南风古灶',
    kind: 'sight',
    area: '石湾',
    destinations: ['佛山', 'foshan'],
    tags: ['landmark', 'experience', 'checkin'],
    blurb: '陶窑文化，换个区域',
  },
  {
    id: 'fs-ticket-zumiao',
    name: '祖庙门票',
    kind: 'ticket',
    area: '禅城区',
    destinations: ['佛山', 'foshan'],
    tags: ['landmark'],
    blurb: '可现场或平台预约',
    url: tripAttractionSearchUrl('佛山祖庙'),
  },
];

const ASPECT_KINDS: Record<TravelAspect, CatalogKind[]> = {
  accommodation: ['stay', 'area'],
  daily_itinerary: ['sight', 'food', 'ticket'],
  tickets: ['ticket'],
  budget_booking: ['ticket', 'stay'],
  emergency: [],
};

const normalize = (text: string): string => text.trim().toLowerCase();

export const matchDestinationKeys = (destination?: string): string[] => {
  const dest = normalize(destination || '');
  if (!dest) return [];
  const keys = new Set<string>();
  for (const place of TRAVEL_CATALOG) {
    for (const key of place.destinations) {
      const k = normalize(key);
      if (dest.includes(k) || k.includes(dest)) keys.add(k);
    }
  }
  // Ski intent without a city name still maps to ski seeds.
  if (/(滑雪|雪场|雪票|缆车|崇礼|太舞|云顶)/.test(dest)) {
    keys.add('滑雪');
    keys.add('崇礼');
  }
  return [...keys];
};

export const isSkiOriented = (text = ''): boolean =>
  /(滑雪|雪场|雪票|缆车|索道|崇礼|太舞|云顶)/.test(text);

export const pickCatalogPlaces = (input: {
  destination?: string;
  aspect: TravelAspect;
  interest?: TravelInterest | null;
  userText?: string;
  limit?: number;
  preferLateStart?: boolean;
}): CatalogPlace[] => {
  const limit = input.limit ?? 3;
  const kinds = ASPECT_KINDS[input.aspect];
  if (!kinds.length) return [];

  // Destination wins over purpose/notes, so "大阪 + 滑雪/票务" does not leak Chongli.
  const destKeys = matchDestinationKeys(input.destination || '');
  const intentSki = isSkiOriented(input.userText || '');
  const destSki = isSkiOriented(input.destination || '');
  const ski = destSki || (!input.destination && intentSki);

  let pool = TRAVEL_CATALOG.filter((place) => kinds.includes(place.kind));
  if (destKeys.length) {
    const matched = pool.filter((place) =>
      place.destinations.some((key) => destKeys.includes(normalize(key))),
    );
    // Only use curated seeds when destination actually matches.
    pool = matched;
  } else if (ski) {
    pool = pool.filter((place) => place.tags.includes('ski'));
  } else if (input.destination || input.userText) {
    // Unknown destination: do not leak Paris/ski seeds; caller uses generics.
    pool = [];
  }

  const scored = pool
    .map((place) => {
      let score = 0;
      if (input.interest && place.tags.includes(input.interest)) score += 3;
      if (ski && place.tags.includes('ski')) score += 4;
      if (input.preferLateStart && place.tags.includes('relax')) score += 2;
      if (place.kind === 'ticket' && input.aspect === 'tickets') score += 1;
      return { place, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked: CatalogPlace[] = [];
  const usedAreas = new Set<string>();
  for (const row of scored) {
    if (picked.length >= limit) break;
    // Prefer diversity of areas for itinerary; allow same area for tickets.
    if (
      input.aspect === 'daily_itinerary' &&
      usedAreas.has(row.place.area) &&
      picked.length > 0
    ) {
      continue;
    }
    picked.push(row.place);
    usedAreas.add(row.place.area);
  }

  // If diversity filter emptied the list, fall back to top scores.
  if (!picked.length) {
    return scored.slice(0, limit).map((row) => row.place);
  }
  return picked;
};

export const formatCatalogOption = (
  place: CatalogPlace,
  options: { withUrl?: boolean } = {},
): string => {
  const base = `${place.name}（${place.area}·${place.blurb}）`;
  if (options.withUrl && place.url) {
    return `${base} 预订链接：${place.url}`;
  }
  return base;
};

/** Match a user confirmation to one catalog option (by name/area/ordinal). */
export const matchSelectedCatalogPlace = (
  places: CatalogPlace[],
  raw: string,
): CatalogPlace | null => {
  const text = raw.replace(/\s+/g, '').trim();
  if (!text || !places.length) return null;

  for (const place of places) {
    const name = place.name.replace(/\s+/g, '');
    const area = place.area.replace(/\s+/g, '');
    if (name && text.includes(name)) return place;
    if (area.length >= 2 && text.includes(area) && places.length <= 3) {
      // Area alone is weak; only accept when paired with 选/要/订.
      if (/(选|要|订|定|就)/.test(text)) return place;
    }
  }

  if (/(第一个|第1个|选1|选一|要1|要一|选第一个)/.test(text)) {
    return places[0] || null;
  }
  if (/(第二个|第2个|选2|选二|要2|要二|选第二个)/.test(text)) {
    return places[1] || null;
  }
  if (/(第三个|第3个|选3|选三|要3|要三|选第三个)/.test(text)) {
    return places[2] || null;
  }

  if (/(就这个|就它|定这个|要这个|就选这个|选定了|就它了)/.test(text)) {
    return places[0] || null;
  }
  return null;
};

/**
 * Destination-agnostic ticket channels. Used when we have no curated seed:
 * openable booking-platform URLs — never Bing, never GUI click-loops.
 */
export const buildGenericTicketOptions = (input: {
  destination?: string;
  userText?: string;
  limit?: number;
}): CatalogPlace[] => {
  const dest = (input.destination || '目的地').trim() || '目的地';
  const options: CatalogPlace[] = [
    {
      id: `generic-trip-ticket-${dest}`,
      name: `${dest} · Trip.com 景点门票`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['landmark'],
      blurb: '可直接选日期下单',
      url: tripAttractionSearchUrl(dest),
    },
    {
      id: `generic-ctrip-ticket-${dest}`,
      name: `${dest} · 携程门票/预约`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['landmark'],
      blurb: '国内常用票务入口',
      url: ctripTicketSearchUrl(dest),
    },
    {
      id: `generic-damai-${dest}`,
      name: `${dest} · 大麦演出/展览`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['experience'],
      blurb: '展演类走票务平台',
      url: damaiSearchUrl(dest),
    },
  ];
  return options.slice(0, input.limit ?? 3);
};

/** Hotel / stay booking links for any destination — link-only, no GUI. */
export const buildGenericStayOptions = (input: {
  destination?: string;
  userText?: string;
  limit?: number;
}): CatalogPlace[] => {
  const dest = (input.destination || '目的地').trim() || '目的地';
  const options: CatalogPlace[] = [
    {
      id: `generic-stay-booking-${dest}`,
      name: `${dest} · Booking.com 酒店`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['landmark', 'relax'],
      blurb: '可筛免费取消',
      url: bookingHotelSearchUrl(dest),
    },
    {
      id: `generic-stay-trip-${dest}`,
      name: `${dest} · Trip.com 酒店`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['relax'],
      blurb: '国际站库存与比价',
      url: tripHotelSearchUrl(dest),
    },
    {
      id: `generic-stay-ctrip-${dest}`,
      name: `${dest} · 携程酒店`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['relax', 'experience'],
      blurb: '国内常用预订入口',
      url: ctripHotelSearchUrl(dest),
    },
  ];
  return options.slice(0, input.limit ?? 3);
};

const withUrl = (
  places: CatalogPlace[],
): Array<CatalogPlace & { url: string }> =>
  places.filter((place): place is CatalogPlace & { url: string } =>
    Boolean(place.url),
  );

/** Booking/official links (tickets + stays) for chat + desktop summary. */
export const listBookingLinks = (input: {
  destination?: string;
  userText?: string;
  limit?: number;
}): Array<{ name: string; url: string; blurb: string }> => {
  const limit = input.limit ?? 6;
  const ticketCurated = withUrl(
    pickCatalogPlaces({
      destination: input.destination,
      aspect: 'tickets',
      userText: input.userText,
      limit: 3,
    }),
  );
  const stayCurated = withUrl(
    pickCatalogPlaces({
      destination: input.destination,
      aspect: 'accommodation',
      userText: input.userText,
      limit: 3,
    }),
  );
  const ticketGeneric =
    ticketCurated.length >= 2
      ? []
      : withUrl(
          buildGenericTicketOptions({
            destination: input.destination,
            userText: input.userText,
            limit: 3,
          }),
        );
  const stayGeneric =
    stayCurated.length >= 2
      ? []
      : withUrl(
          buildGenericStayOptions({
            destination: input.destination,
            userText: input.userText,
            limit: 3,
          }),
        );
  return [...ticketCurated, ...ticketGeneric, ...stayCurated, ...stayGeneric]
    .slice(0, limit)
    .map((place) => ({
      name: place.name,
      url: place.url,
      blurb: place.blurb,
    }));
};

/** Concrete ticket/stay options for any destination (catalog first, else generic links). */
export const resolveBookableOptions = (input: {
  destination?: string;
  aspect: TravelAspect;
  interest?: TravelInterest | null;
  userText?: string;
  preferLateStart?: boolean;
  limit?: number;
}): CatalogPlace[] => {
  const limit = input.limit ?? 3;
  const curated = pickCatalogPlaces(input);
  if (input.aspect === 'accommodation') {
    const withLinks = withUrl(curated);
    if (withLinks.length >= 2) return withLinks.slice(0, limit);
    if (withLinks.length === 1) {
      return [
        withLinks[0],
        ...buildGenericStayOptions({
          destination: input.destination,
          userText: input.userText,
          limit: limit - 1,
        }),
      ].slice(0, limit);
    }
    return buildGenericStayOptions({
      destination: input.destination,
      userText: input.userText,
      limit,
    });
  }
  if (curated.length >= 2) return curated.slice(0, limit);
  if (input.aspect === 'tickets' || input.aspect === 'budget_booking') {
    return buildGenericTicketOptions({
      destination: input.destination,
      userText: input.userText,
      limit,
    });
  }
  return curated;
};

/** Named POI stubs for preference probing when search returns nothing. */
export const cityHighlightSeeds = (
  destination?: string,
): Partial<Record<TravelInterest, { title: string; detail: string }>> => {
  const dest = (destination || '').toLowerCase();
  if (/(北京|beijing)/.test(dest)) {
    return {
      food: { title: '簋街小龙虾 / 三里屯餐厅', detail: '晚饭主线，适合吃货' },
      checkin: {
        title: '三里屯太古里 + 南锣鼓巷',
        detail: '下午街拍，晚上可转什刹海',
      },
      landmark: {
        title: '故宫博物院',
        detail: '早场预约，经典半日',
      },
      experience: {
        title: '什刹海酒吧街 / 798艺术区',
        detail: '想轻松夜生活或逛展都行',
      },
    };
  }
  if (/(佛山|foshan|顺德)/.test(dest)) {
    return {
      food: {
        title: '顺德凤城食街 + 民信双皮奶',
        detail: '正餐加甜品，冲着吃',
      },
      checkin: { title: '岭南天地', detail: '逛街出片' },
      landmark: { title: '佛山祖庙', detail: '半日经典' },
      experience: { title: '清晖园 / 南风古灶', detail: '园林或陶窑二选一' },
    };
  }
  if (/(巴黎|paris)/.test(dest)) {
    return {
      food: { title: '圣日耳曼法式小馆', detail: '经典晚饭' },
      checkin: { title: '圣心堂阶梯 / 塞纳河', detail: '黄昏出片' },
      landmark: { title: '卢浮宫', detail: '预约场次' },
      experience: { title: '塞纳河游船', detail: '少走路的夜游' },
    };
  }
  return {};
};

/**
 * Build spoken, executable day lines — distinct places per slot and per day.
 */
export const buildDayPlanFromCatalog = (input: {
  destination?: string;
  interest?: TravelInterest | null;
  userText?: string;
  preferLateStart?: boolean;
  dayCount?: number;
}): string => {
  const oneDay = /(一天|一日|1\s*天|当日|就一天)/.test(
    `${input.userText || ''}`,
  );
  const days = Math.max(
    1,
    Math.min(input.dayCount ?? (oneDay ? 1 : 2), oneDay ? 1 : 3),
  );
  const ski = isSkiOriented(
    `${input.destination || ''} ${input.userText || ''}`,
  );
  const interest = input.interest || null;
  // Raw destination pool (no area-diversity collapse) so slots can differ.
  const destKeys = matchDestinationKeys(input.destination);
  const inDest = (place: CatalogPlace): boolean =>
    destKeys.length > 0 &&
    place.destinations.some((key) => destKeys.includes(normalize(key)));
  const sightPool = TRAVEL_CATALOG.filter(
    (place) => place.kind === 'sight' && inDest(place),
  );
  const foodPool = TRAVEL_CATALOG.filter(
    (place) => place.kind === 'food' && inDest(place),
  );
  const nightlife = sightPool.filter((place) =>
    /酒吧/.test(`${place.name}${place.blurb}`),
  );

  const dest = input.destination || '当地';
  const seeds = cityHighlightSeeds(dest);
  const used = new Set<string>();
  const takeName = (
    candidates: Array<string | undefined>,
    fallback: string,
  ): string => {
    for (const name of candidates) {
      if (!name) continue;
      if (used.has(name)) continue;
      used.add(name);
      return name;
    }
    return fallback;
  };

  const lines: string[] = [];
  for (let day = 0; day < days; day += 1) {
    const start = input.preferLateStart ? '不赶早、偏晚出门' : '按你的节奏出门';
    if (ski) {
      const ticket =
        pickCatalogPlaces({
          destination: input.destination,
          aspect: 'tickets',
          userText: input.userText,
          preferLateStart: input.preferLateStart,
          limit: 2,
        })[day] || null;
      const lunchName = takeName(
        [foodPool[day]?.name, foodPool[day + 1]?.name],
        '雪场附近吃饭',
      );
      const slope = takeName(
        [sightPool[day * 2]?.name, sightPool[day]?.name],
        '雪道',
      );
      const backup = takeName(
        [sightPool[day * 2 + 1]?.name, sightPool[day + 1]?.name],
        '温泉或早收',
      );
      lines.push(
        `Day${day + 1}（${start}）：先搞定${ticket ? ticket.name : '雪票'}，中午${lunchName}，下午在${slope}滑；累了改去${backup}`,
      );
      continue;
    }

    const morning =
      interest === 'food'
        ? takeName(
            [
              foodPool[day]?.name,
              foodPool.find((item) => /早茶|点心/.test(item.name))?.name,
              sightPool[day * 2]?.name,
              seeds.landmark?.title,
            ],
            `${dest}一个热门点`,
          )
        : takeName(
            [
              sightPool[day * 2]?.name,
              sightPool[day]?.name,
              interest === 'landmark' ? seeds.landmark?.title : undefined,
              interest === 'checkin' ? seeds.checkin?.title : undefined,
              seeds.landmark?.title,
            ],
            `${dest}一个热门点`,
          );
    const noon = takeName(
      [
        foodPool[
          (day + (interest === 'food' ? 1 : 0)) %
            Math.max(foodPool.length || 1, 1)
        ]?.name,
        foodPool[day]?.name,
        foodPool[0]?.name,
        seeds.food?.title,
      ],
      `${dest}附近一家口碑餐厅`,
    );
    const afternoon = takeName(
      [
        sightPool[day * 2 + 1]?.name,
        sightPool.find((item) => !used.has(item.name))?.name,
        foodPool.find(
          (item) => !used.has(item.name) && /双皮奶|甜|小吃/.test(item.name),
        )?.name,
        seeds.experience?.title,
        seeds.checkin?.title,
      ],
      `${dest}另一个点`,
    );
    const evening = nightlife[day]?.name || nightlife[0]?.name;
    const ask =
      day === days - 1
        ? evening
          ? `晚上可去${evening}，你想坐坐吗？`
          : '这条可以的话说「就按这版」，要换点直接说。'
        : '';

    lines.push(
      `Day${day + 1}（${start}）：上午去${morning}，中午在${noon}吃，下午去${afternoon}。${ask}`.trim(),
    );
  }
  return lines.join(' ');
};
