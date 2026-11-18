/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isExplicitChat } from './intent-gate';
import { findSiteInText } from './site-registry';

export type SearchIntentConfidence = 'high' | 'medium' | 'low';

export interface SearchIntentDecision {
  isSearch: boolean;
  confidence: SearchIntentConfidence;
  /** A compact query the voice model can pass to search_web. */
  query: string;
  reason: string;
}

export type VoiceIntentMode =
  | 'navigate'
  | 'search'
  | 'compare'
  | 'task'
  | 'chat'
  | 'ambiguous';

export type VoiceTargetKind = 'site' | 'app' | null;

export interface VoiceIntentDecision {
  mode: VoiceIntentMode;
  confidence: SearchIntentConfidence;
  query: string;
  target: string | null;
  targetKind: VoiceTargetKind;
  /** The user wants the page opened without a spoken summary. */
  silent: boolean;
  /** "打开B站搜一下猫": search inside the named site, not the whole web. */
  siteSearch?: boolean;
  reason: string;
}

const EXPLICIT_SEARCH_PATTERNS: RegExp[] = [
  /(搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查询|查找|找一下|找一找|找找|上网查|网上查|帮我查|帮我搜|百度一下|谷歌一下|必应一下|bing一下|google一下)/i,
  /\b(search|look up|google|bing)\b/i,
];

const INFO_PATTERNS: RegExp[] = [
  /(多少钱|价格|报价|票价|机票|酒店|航班|火车票|高铁|门票|天气|新闻|最新|如何|是什么|谁是|在哪|哪里|附近|推荐|对比|比较|哪个好|值得|攻略|教程|步骤|方法|指南|怎么弄|怎么办|营业时间|评价|评分|汇率|路线|地铁|公交|签证|景点|政策|规定|区别|原因|结果|赛程|比分|股价|翻译|意思|电话|地址|简介|介绍|资料|生平|百科|背景|贡献|投币)/,
  /\b(price|cost|weather|news|flight|hotel|ticket|how to|what is|who is|where is|recommend|compare|review|route|visa|policy)\b/i,
];

const SHOPPING_PATTERNS: RegExp[] = [
  /(买|购买|入手|选购|下单|性价比|降噪|耳机|手机|电脑|相机|平板|手表|键盘|鼠标|显示器)/,
  /\b(buy|purchase|deal|headphone|phone|laptop|camera)\b/i,
];

const TRAVEL_PATTERNS: RegExp[] = [
  /(旅游|旅行|出差|自由行|景点|好玩|美食|住宿|酒店|机票|航班|签证|攻略|巴黎|伦敦|纽约|东京|大阪|首尔|新加坡|曼谷|悉尼|洛杉矶|旧金山|上海|北京|广州|深圳|成都|杭州|三亚|香港|澳门|台北)/,
  /\b(travel|trip|flight|hotel|visa|tour|paris|london|tokyo|new york)\b/i,
];

const DESIRE_PATTERNS: RegExp[] = [
  /(我要|我想|想要|打算|准备|计划|需要|帮我|给我|能不能|可不可以|可以帮我|请帮|麻烦|替我)/,
  /\b(i want|i'd like|i would like|can you|could you|please|help me)\b/i,
];

const QUESTION_PATTERNS: RegExp[] = [
  /[?？]/,
  /(吗|呢|多少|什么|怎么|为什么|哪|谁|几|如何|是否)/,
];

const POINTER_PATTERNS: RegExp[] = [
  /(这个|那个|它|它们|这台|那台|这款|那款|左边|右边)/,
  /\b(this|that|it|left|right)\b/i,
];

const PRICE_PATTERNS: RegExp[] = [
  /(多少钱|价格|报价|票价|售价|优惠|折扣|性价比|评测|推荐|买|购买)/,
  /\b(price|cost|deal|review|buy|purchase)\b/i,
];

/**
 * Local/system lookups must stay with the desktop agent. "查一下电脑配置"
 * sounds like a search request but is a local task.
 */
const LOCAL_LOOKUP_PATTERNS: RegExp[] = [
  /(文件|文件夹|桌面|本机|系统|设置|应用|软件|窗口|按钮|进程|内存|磁盘|IP|ip|路径|目录|代码|脚本|程序|终端|命令行|注册表|配置)/,
  /\b(file|folder|desktop|computer|system|settings|app|window|button|process|memory|disk|path|directory|code|script|program|terminal|command|registry|config)\b/i,
];

const WAKE_PREFIX =
  /^(hello|hi|hey|hallo|你好|您好|嗨|哈喽|哈啰|哈罗)[\s,，]*(cyrvis|cyrus|cyris|sirvis|cervis|service|赛维斯|瑟维斯)?[\s,，]*/i;

const LEADING_FILLERS =
  /^(请帮我|请帮忙|请给我|请你|帮我一下|帮我|请帮|请|麻烦|你能不能|你能|可以帮我|可不可以|可以|我想知道|我想了解|我想看看|我要看看|我想|我要|想要|打算|准备|计划|给我|替我|帮忙|你帮我|请问|告诉我|了解一下|了解下|了解|看看|看一下|瞧瞧|一下)+/;

const SEARCH_PREFIX =
  /^(搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查询|查找|找一下|找一找|找找|上网查一下|上网查|网上查|百度一下|谷歌一下|必应一下)\s*/;

const TRAILING_POLITENESS =
  /(吧|呢|啊|呀|吗|嘛|哦|一下|谢谢你|谢谢|可以吗|好不好|怎么样)[。！!？?，,\s]*$/;

const TRAILING_SILENT =
  /(我自己看|自己看|别念|不用念|不要念|别读|不用读|不要读|不用总结|不要总结|打开就行|只看页面)[。！!？?，,\s]*$/;

const SILENT_PATTERNS: RegExp[] = [
  /(我自己看|自己看|别念|不用念|不要念|别读|不用读|不要读|不用总结|不要总结|打开就行|只看页面)/,
  /\b(just open|don't read|do not read|no summary|i'll browse)\b/i,
];

const NAV_VERB_PATTERN =
  /^(?:打开|启动|进入|切到|切换到|跳到|去|访问|open\b|launch\b|go\s+to\b|visit\b)/i;

const BARE_SEARCH_NAV =
  /^(打开|进入|切到|切换到|去)\s*(搜索|搜索引擎|浏览器)[\s，,]*((我自己看|自己看|别念|不用念|不要念|打开就行|只看页面))?[。！!？?，,\s]*$/;

const COMPARE_PATTERNS: RegExp[] = [
  /(比较|对比|最便宜|最低价|性价比|哪个好|哪个便宜|推荐|最优|最合适)/,
  /\b(compare|cheapest|best value|recommend)\b/i,
];

const TASK_PATTERNS: RegExp[] = [
  /(点击|点一下|双击|输入|填写|保存|下载|安装|运行|创建|新建|写入|编辑|修改|复制|移动|删除|重命名|整理|截图|录屏|预订|下单|支付|提交|确认订单|加入购物车|登录)/,
  /\b(click|type|save|download|install|run|create|write|edit|modify|copy|move|delete|rename|screenshot|book|order|pay|submit|fill|login)\b/i,
];

const SHOPPING_ACTION_PATTERN = /(买|购买|选购)/;

interface AppTarget {
  id: 'vscode' | 'chrome' | 'explorer' | 'notepad';
  aliases: string[];
}

const APP_TARGETS: AppTarget[] = [
  {
    id: 'vscode',
    aliases: ['vs code', 'vscode', 'visual studio code', '代码编辑器'],
  },
  {
    id: 'chrome',
    aliases: ['google chrome', 'chrome', '谷歌浏览器'],
  },
  {
    id: 'explorer',
    aliases: ['资源管理器', '文件管理器', 'file explorer', 'explorer'],
  },
  {
    id: 'notepad',
    aliases: ['记事本', 'notepad'],
  },
];

const matches = (patterns: RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

const trimQueryPunctuation = (text: string): string =>
  text
    .replace(/^[，。！？、,.!?;；:：\s]+/, '')
    .replace(/[，。！？、,.!?;；:：\s]+$/, '')
    .trim();

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsAlias = (text: string, alias: string): boolean => {
  const normalized = alias.toLowerCase();
  if (/^[a-z0-9.]+$/.test(normalized)) {
    return new RegExp(
      `(^|[^a-z0-9])${escapeRegex(normalized)}([^a-z0-9]|$)`,
      'i',
    ).test(text);
  }
  return text.toLowerCase().includes(normalized);
};

const findAppTarget = (text: string): AppTarget['id'] | null => {
  for (const target of APP_TARGETS) {
    if (target.aliases.some((alias) => containsAlias(text, alias))) {
      return target.id;
    }
  }
  return null;
};

const stripSitePrefix = (value: string): string => {
  const site = findSiteInText(value);
  if (!site) {
    return value;
  }
  const aliases = [...site.aliases].sort(
    (left, right) => right.length - left.length,
  );
  for (const alias of aliases) {
    const pattern = new RegExp(
      `^(打开|进入|切到|切换到|跳到|去|访问|open|launch|go\\s+to|visit)?\\s*` +
        `${escapeRegex(alias)}\\s*` +
        `(搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查询|查找|找一下|找一找|找找|搜|查)?\\s*`,
      'i',
    );
    if (pattern.test(value)) {
      const stripped = trimQueryPunctuation(value.replace(pattern, ''));
      if (stripped) {
        return stripped;
      }
    }
  }
  return value;
};

const stripNavigationSearchPrefix = (value: string): string =>
  value
    .replace(
      /^(打开|进入|切到|切换到|跳到|去|访问|open\b|launch\b|visit\b)\s*(浏览器|搜索|搜索引擎)\s*(搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查询|查找|找一下|找一找|找找|搜|查)?\s*/i,
      '',
    )
    .replace(
      /^(打开|进入|切到|切换到|跳到|访问|open\b|launch\b|visit\b)\s*(搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查询|查找|找一下|找一找|找找|搜|查)\s*/i,
      '',
    );

/**
 * Turn "帮我搜索一下去巴黎的机票" into "去巴黎的机票". The result is only a
 * hint for the model; the model may still rewrite it.
 */
export const extractSearchQuery = (text: string): string => {
  const original = trimQueryPunctuation(text);
  let query = trimQueryPunctuation(original.replace(WAKE_PREFIX, ''));

  for (let i = 0; i < 4; i += 1) {
    const before = query;
    query = trimQueryPunctuation(query.replace(LEADING_FILLERS, ''));
    query = trimQueryPunctuation(query.replace(SEARCH_PREFIX, ''));
    if (query === before) {
      break;
    }
  }

  for (let i = 0; i < 2; i += 1) {
    query = trimQueryPunctuation(query.replace(TRAILING_POLITENESS, ''));
    query = trimQueryPunctuation(query.replace(TRAILING_SILENT, ''));
  }

  query = trimQueryPunctuation(stripSitePrefix(query));
  query = trimQueryPunctuation(stripNavigationSearchPrefix(query));

  if (!query) {
    return original.slice(0, 120);
  }
  return query.slice(0, 120);
};

/**
 * Deterministic "does this utterance need the web?" classifier.
 *
 * The realtime model still decides which tool to call. This module exists to
 * (a) auto-wake on a clear search need without "Hello CYRVIS", and (b) reject
 * a start_gui_task call that is really a search request. Keep it conservative:
 * high-confidence signals only for the guard.
 */
export const detectSearchIntent = (text: string): SearchIntentDecision => {
  const raw = text.trim();
  if (!raw) {
    return {
      isSearch: false,
      confidence: 'low',
      query: '',
      reason: 'empty',
    };
  }

  const query = extractSearchQuery(raw);
  const explicit = matches(EXPLICIT_SEARCH_PATTERNS, raw);
  const info = matches(INFO_PATTERNS, raw);
  const shopping = matches(SHOPPING_PATTERNS, raw);
  const travel = matches(TRAVEL_PATTERNS, raw);
  const desire = matches(DESIRE_PATTERNS, raw);
  const question = matches(QUESTION_PATTERNS, raw);
  const pointer = matches(POINTER_PATTERNS, raw);
  const price = matches(PRICE_PATTERNS, raw);
  const localLookup = matches(LOCAL_LOOKUP_PATTERNS, raw);

  // "今天天气怎么样" matches the chat heuristic because of "怎么样", but it
  // also has a concrete information keyword, so it is a search need.
  if (isExplicitChat(raw) && !explicit && !info && !shopping && !travel) {
    return {
      isSearch: false,
      confidence: 'low',
      query: raw,
      reason: 'explicit chat',
    };
  }

  if (!query) {
    return {
      isSearch: false,
      confidence: 'low',
      query: raw,
      reason: 'no concrete query',
    };
  }

  // "查一下电脑配置" / "文件怎么保存" should stay with the GUI/local tools,
  // unless the user is clearly asking about a price, purchase, or review.
  if (localLookup && !price) {
    return {
      isSearch: false,
      confidence: 'low',
      query,
      reason: 'local/system lookup',
    };
  }

  if (explicit) {
    return {
      isSearch: true,
      confidence: 'high',
      query,
      reason: 'explicit search request',
    };
  }

  if (info) {
    // "这个多少钱" depends on what is on screen; do not redirect it blindly.
    if (pointer && !desire) {
      return {
        isSearch: true,
        confidence: 'medium',
        query,
        reason: 'pointer-dependent information need',
      };
    }
    if (desire || question) {
      return {
        isSearch: true,
        confidence: 'high',
        query,
        reason: 'information need with desire/question',
      };
    }
    return {
      isSearch: true,
      confidence: 'medium',
      query,
      reason: 'information keyword',
    };
  }

  if (shopping && desire) {
    return {
      isSearch: true,
      confidence: 'high',
      query,
      reason: 'shopping/research desire',
    };
  }

  if (travel && (desire || question)) {
    return {
      isSearch: true,
      confidence: 'high',
      query,
      reason: 'travel information need',
    };
  }

  if (travel) {
    return {
      isSearch: true,
      confidence: 'medium',
      query,
      reason: 'travel keyword',
    };
  }

  return {
    isSearch: false,
    confidence: 'low',
    query,
    reason: 'no search signal',
  };
};

export const isHighConfidenceSearch = (text: string): boolean =>
  detectSearchIntent(text).confidence === 'high';

/**
 * Unified voice routing: navigation, search/answer, comparison, desktop task,
 * chat, or ambiguous. The realtime model still chooses the tool; this decision
 * is used for prompts, auto-wake, and rejecting obviously wrong tool calls.
 */
export const classifyVoiceIntent = (text: string): VoiceIntentDecision => {
  const raw = text.trim();
  if (!raw) {
    return {
      mode: 'ambiguous',
      confidence: 'low',
      query: '',
      target: null,
      targetKind: null,
      silent: false,
      reason: 'empty',
    };
  }

  const silent = matches(SILENT_PATTERNS, raw);
  const searchIntent = detectSearchIntent(raw);
  const site = findSiteInText(raw);
  const app = findAppTarget(raw);
  const navVerb = NAV_VERB_PATTERN.test(raw);
  const compare = matches(COMPARE_PATTERNS, raw);
  const task = matches(TASK_PATTERNS, raw);
  const shoppingAction = SHOPPING_ACTION_PATTERN.test(raw);
  const pointer = matches(POINTER_PATTERNS, raw);
  const query = extractSearchQuery(raw);
  const siteSearch =
    navVerb && !!site && (searchIntent.isSearch || shoppingAction);

  if (
    isExplicitChat(raw) &&
    !searchIntent.isSearch &&
    !compare &&
    !task &&
    !site &&
    !app
  ) {
    return {
      mode: 'chat',
      confidence: 'low',
      query,
      target: null,
      targetKind: null,
      silent,
      reason: 'explicit chat',
    };
  }

  if (task) {
    return {
      mode: 'task',
      confidence: 'high',
      query,
      target: app ?? site?.id ?? null,
      targetKind: app ? 'app' : site ? 'site' : null,
      silent,
      reason: 'desktop operation/transaction',
    };
  }

  if (compare) {
    return {
      mode: 'compare',
      confidence:
        searchIntent.confidence === 'low' ? 'medium' : searchIntent.confidence,
      query,
      target: site?.id ?? null,
      targetKind: site ? 'site' : null,
      silent,
      reason: 'comparison/recommendation',
    };
  }

  // "打开搜索，我自己看" is navigation; "打开浏览器搜索巴黎机票" is search.
  if (BARE_SEARCH_NAV.test(raw)) {
    return {
      mode: 'navigate',
      confidence: 'high',
      query,
      target: 'bing',
      targetKind: 'site',
      silent: true,
      reason: 'open search engine',
    };
  }

  if (pointer && searchIntent.confidence !== 'high' && !site) {
    return {
      mode: 'ambiguous',
      confidence: 'low',
      query,
      target: null,
      targetKind: null,
      silent,
      reason: 'pointer without a concrete search target',
    };
  }

  if (searchIntent.isSearch) {
    return {
      mode: 'search',
      confidence: searchIntent.confidence,
      query,
      target: site?.id ?? null,
      targetKind: site ? 'site' : null,
      silent,
      siteSearch,
      reason: searchIntent.reason,
    };
  }

  if (navVerb && shoppingAction && site) {
    return {
      mode: 'search',
      confidence: 'medium',
      query,
      target: site.id,
      targetKind: 'site',
      silent,
      siteSearch: true,
      reason: 'site shopping search',
    };
  }

  if (navVerb && site) {
    return {
      mode: 'navigate',
      confidence: 'high',
      query,
      target: site.id,
      targetKind: 'site',
      silent,
      reason: 'open site',
    };
  }

  if (navVerb && app) {
    return {
      mode: 'navigate',
      confidence: 'high',
      query,
      target: app,
      targetKind: 'app',
      silent,
      reason: 'open app',
    };
  }

  if (pointer) {
    return {
      mode: 'ambiguous',
      confidence: 'low',
      query,
      target: null,
      targetKind: null,
      silent,
      reason: 'pointer without a concrete target',
    };
  }

  return {
    mode: 'ambiguous',
    confidence: 'low',
    query,
    target: null,
    targetKind: null,
    silent,
    reason: 'no clear navigation or search signal',
  };
};
