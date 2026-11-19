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
    url: 'https://www.bing.com/search?q=Paris%20Latin%20Quarter%20hotel%20free%20cancellation',
  },
  {
    id: 'paris-stay-marais',
    name: '马莱区设计公寓',
    kind: 'stay',
    area: '马莱区',
    destinations: ['巴黎', 'paris'],
    tags: ['checkin', 'food'],
    blurb: '出片街巷多、晚饭选择密',
    url: 'https://www.bing.com/search?q=Le%20Marais%20Paris%20apartment%20hotel',
  },
  {
    id: 'paris-stay-stgermain',
    name: '圣日耳曼旁三星酒店',
    kind: 'stay',
    area: '圣日耳曼',
    destinations: ['巴黎', 'paris'],
    tags: ['landmark', 'experience'],
    blurb: '地铁方便、不赶早也好出门',
    url: 'https://www.bing.com/search?q=Saint-Germain%20Paris%20hotel',
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
  },
  {
    id: 'paris-sight-sacre',
    name: '圣心堂阶梯打卡',
    kind: 'sight',
    area: '蒙马特',
    destinations: ['巴黎', 'paris'],
    tags: ['checkin'],
    blurb: '黄昏光线好，少爬坡选缆车',
  },
  {
    id: 'paris-sight-seine',
    name: '塞纳河黄昏游船',
    kind: 'sight',
    area: '塞纳河',
    destinations: ['巴黎', 'paris'],
    tags: ['experience', 'checkin'],
    blurb: '坐船少走路，适合轻松夜',
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

export const formatCatalogOption = (place: CatalogPlace): string =>
  place.url
    ? `${place.name}（${place.area}·${place.blurb}）链接：${place.url}`
    : `${place.name}（${place.area}·${place.blurb}）`;

/**
 * Destination-agnostic ticket channels. Used when we have no curated seed:
 * still give openable URLs in chat/notes — never GUI click-loops.
 */
export const buildGenericTicketOptions = (input: {
  destination?: string;
  userText?: string;
  limit?: number;
}): CatalogPlace[] => {
  const dest = (input.destination || '目的地').trim() || '目的地';
  const q = encodeURIComponent(`${dest} 门票 官网 预约`);
  const qShow = encodeURIComponent(`${dest} 演出 展览 门票`);
  const options: CatalogPlace[] = [
    {
      id: `generic-official-${dest}`,
      name: `${dest}官方/景点预约入口`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['landmark'],
      blurb: '优先官网时段，避免黄牛',
      url: `https://www.bing.com/search?q=${q}`,
    },
    {
      id: `generic-agg-${dest}`,
      name: `${dest}门票聚合预订`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['landmark'],
      blurb: '比价与库存一眼看',
      url: `https://www.bing.com/search?q=${encodeURIComponent(`${dest} 门票 预订 site:ctrip.com OR site:trip.com`)}`,
    },
    {
      id: `generic-show-${dest}`,
      name: `${dest}演出/展览票`,
      kind: 'ticket',
      area: dest,
      destinations: [dest],
      tags: ['experience'],
      blurb: '展演类走票务平台',
      url: `https://www.bing.com/search?q=${qShow}`,
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
  const qHotel = encodeURIComponent(`${dest} 酒店 预订 可免费取消`);
  const qAgg = encodeURIComponent(
    `${dest} 酒店 site:booking.com OR site:ctrip.com OR site:trip.com`,
  );
  const qApt = encodeURIComponent(`${dest} 民宿 公寓 预订`);
  const options: CatalogPlace[] = [
    {
      id: `generic-stay-center-${dest}`,
      name: `${dest}市中心/交通方便酒店`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['landmark', 'relax'],
      blurb: '可免费取消优先',
      url: `https://www.bing.com/search?q=${qHotel}`,
    },
    {
      id: `generic-stay-agg-${dest}`,
      name: `${dest}酒店比价预订`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['relax'],
      blurb: '多平台看库存与价格',
      url: `https://www.bing.com/search?q=${qAgg}`,
    },
    {
      id: `generic-stay-apt-${dest}`,
      name: `${dest}民宿/公寓备选`,
      kind: 'stay',
      area: dest,
      destinations: [dest],
      tags: ['relax', 'experience'],
      blurb: '住久或人多更合适',
      url: `https://www.bing.com/search?q=${qApt}`,
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

export const buildDayPlanFromCatalog = (input: {
  destination?: string;
  interest?: TravelInterest | null;
  userText?: string;
  preferLateStart?: boolean;
  dayCount?: number;
}): string => {
  const days = Math.max(1, Math.min(input.dayCount ?? 2, 3));
  const ski = isSkiOriented(
    `${input.destination || ''} ${input.userText || ''}`,
  );
  const sights = pickCatalogPlaces({
    ...input,
    aspect: 'daily_itinerary',
    limit: days * 2,
  });
  const foods = pickCatalogPlaces({
    destination: input.destination,
    aspect: 'daily_itinerary',
    interest: 'food',
    userText: input.userText,
    limit: days,
  }).filter((place) => place.kind === 'food');

  const dest = input.destination || '当地';
  const lines: string[] = [];
  for (let day = 0; day < days; day += 1) {
    const main = sights[day] || sights[0];
    const backup =
      sights[day + days] || sights[(day + 1) % Math.max(sights.length, 1)];
    const lunch = foods[day] || foods[0];
    const start = input.preferLateStart ? '偏晚出发' : '按你的节奏出发';
    if (!sights.length && !ski) {
      lines.push(
        `Day${day + 1}（${start}）：上午 ${dest}一个主预约点 → 午饭当地简餐 → 下午同区域备份点；先把需预约的项目锁票`,
      );
      continue;
    }
    if (ski) {
      const ticket =
        pickCatalogPlaces({
          destination: input.destination,
          aspect: 'tickets',
          userText: input.userText,
          preferLateStart: input.preferLateStart,
          limit: 2,
        })[day] || null;
      lines.push(
        `Day${day + 1}（${start}）：${ticket ? ticket.name : '雪票'} → ${
          lunch ? lunch.name : '雪场简餐'
        } → ${main ? main.name : '雪道/小镇'}；备份：${
          backup ? backup.name : '温泉或早收'
        }`,
      );
    } else {
      lines.push(
        `Day${day + 1}（${start}）：上午 ${main ? main.name : '主景点'} → 午饭 ${
          lunch ? lunch.name : '当地简餐'
        } → 下午 ${backup ? backup.name : '同区域备份点'}`,
      );
    }
  }
  return lines.join('。');
};
