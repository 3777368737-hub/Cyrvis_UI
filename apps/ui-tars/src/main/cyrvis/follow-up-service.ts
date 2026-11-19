/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, ipcMain, powerMonitor } from 'electron';
import ElectronStore from 'electron-store';
import { execFile, type ChildProcess } from 'node:child_process';

import { logger } from '@main/logger';
import type { CyrvisMemorySnapshot } from '@shared/cyrvis';
import { voiceMemoryService } from './memory';
import { travelPlanner } from './travel/travel-planner';
import { publishProactiveText, speakProactiveText } from './voice-service';

export type FollowUpReason =
  | 'launch'
  | 'activate'
  | 'resume'
  | 'unlock'
  | 'idle';

export interface FollowUpPrompt {
  id: string;
  reason: FollowUpReason;
  createdAt: number;
  greeting: string;
}

interface FollowUpState {
  enabled: boolean;
  snoozedUntil: number;
  lastPromptAt: number;
  lastGreeting: string;
  pending: FollowUpPrompt | null;
}

const PROMPT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_SNOOZE_MS = 30 * 60 * 1000;
const IDLE_SUGGESTION_SECONDS = 10;
const LIFECYCLE_DEDUPE_MS = 10_000;
const IDLE_AFTER_GREETING_MS = 60_000;

const pickDifferent = (choices: string[], previous: string): string => {
  const candidates = choices.filter((choice) => choice !== previous);
  const pool = candidates.length ? candidates : choices;
  return pool[Math.floor(Math.random() * pool.length)] || choices[0] || '';
};

const createGreeting = (
  date: Date,
  busyYesterday: boolean,
  previous: string,
): string => {
  const hour = date.getHours();
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return pickDifferent(
      [
        '周末好呀，今天想出去走走，还是舒舒服服宅一会儿？',
        '周末上线。工作可以慢一点，快乐可别迟到。',
        '今天是周末，有没有出行计划？需要的话我也能帮你一起安排。',
        '欢迎回来。周末也要记得给自己留一点放空时间。',
      ],
      previous,
    );
  }

  if (busyYesterday) {
    return pickDifferent(
      [
        '欢迎回来。昨天忙了不少，今天休息得还好吗？',
        '昨天工作量挺大，今天我们稳一点，别把自己累着。',
        '又见面啦。昨天推进了很多事情，今天也记得留点喘气的空间。',
      ],
      previous,
    );
  }

  if (hour < 6) {
    return pickDifferent(
      [
        '夜深了，还在努力呀。别忘了，休息也是任务的一部分。',
        '这么晚还见到你，辛苦啦。我们尽量速战速决。',
        '深夜模式已开启。剩下的事情慢慢来，别太为难自己。',
      ],
      previous,
    );
  }
  if (hour < 11) {
    return pickDifferent(
      [
        '早上好，新的一天开工啦，今天也稳稳向前。',
        '早呀，祝你今天思路清晰、一路绿灯。',
        '新的一天见面啦。打起精神，我们把事情一件件搞定。',
      ],
      previous,
    );
  }
  if (hour < 14) {
    return pickDifferent(
      [
        '中午好，忙归忙，也要记得按时吃饭。',
        '午间上线。上午辛苦了，下午继续稳稳推进。',
        '中午好呀，先补充能量，再继续解决问题。',
      ],
      previous,
    );
  }
  if (hour < 18) {
    return pickDifferent(
      [
        '下午好，今天的进度条已经过半，继续加油。',
        '欢迎回来。下午也要保持节奏，别被琐事牵着跑。',
        '下午好呀，再推进一点，离收工就更近一步。',
      ],
      previous,
    );
  }
  return pickDifferent(
    [
      '晚上好，今天辛苦了。需要我帮你收个尾吗？',
      '欢迎回来。忙了一天，我们把剩下的事情轻松处理掉。',
      '晚上好呀，今天已经很努力了，接下来别给自己太大压力。',
    ],
    previous,
  );
};

const clipDetail = (text: string, max = 48): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
};

/** Greetings / status checks — never quote these as the “task topic”. */
const isLowSignalUtterance = (text: string): boolean => {
  const t = text.replace(/\s+/g, '').trim();
  if (!t || t.length < 4) return true;
  if (
    /^(你好|您好|嗨|在吗|嘿|嗯|好的|好|行|谢谢|收到|继续|然后呢|ok|hi|hello)[吗呀啊呢。！？!?.]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /(删除了吗|做完了吗|好了吗|完成了吗|弄好了吗|怎么样了|还在吗|听见了吗)/.test(
    t,
  );
};

const stripTaskPrefix = (text: string): string =>
  text
    .replace(/^启动电脑任务[:：]\s*/, '')
    .replace(/^(已经|已|我)?(帮你)?/, '')
    .trim();

/** Prefer action summary over echoing the latest user sentence. */
const synthesizeRecentWork = (
  memory: CyrvisMemorySnapshot,
): { action: string; objectHint: string | null } | null => {
  const recentActivities = [...memory.activities].slice(-8).reverse();
  for (const activity of recentActivities) {
    const raw = stripTaskPrefix(activity.text);
    if (!raw || isLowSignalUtterance(raw)) continue;
    if (
      activity.kind === 'task' ||
      /启动电脑任务|删除|新建|创建|写入|打开|整理|下载|保存|旅行计划/.test(
        activity.text,
      )
    ) {
      return {
        action: clipDetail(raw, 36),
        objectHint: raw.match(/桌面|旅行计划|文件|文件夹|记事本/)?.[0] || null,
      };
    }
  }

  const recentAssistant = [...memory.turns]
    .filter((turn) => turn.role === 'assistant')
    .slice(-6)
    .reverse();
  for (const turn of recentAssistant) {
    const text = turn.text.trim();
    if (isLowSignalUtterance(text)) continue;
    const done =
      text.match(
        /(?:已|已经)?(?:帮你)?(删(?:除|掉)|清理|新建|创建|写入|保存|打开|整理|下载)[^。！？!?]{0,28}/,
      )?.[0] || text.match(/桌面上的[^。！？!?]{0,20}(?:文件|计划)/)?.[0];
    if (done) {
      return { action: clipDetail(done, 36), objectHint: null };
    }
  }

  const substantiveUser = [...memory.turns]
    .filter((turn) => turn.role === 'user')
    .slice(-10)
    .reverse()
    .map((turn) => turn.text.trim())
    .find(
      (text) =>
        !isLowSignalUtterance(text) &&
        /(删|删除|清理|新建|创建|写入|打开|整理|下载|保存|帮我|给我|把.+|旅行|计划|文件)/.test(
          text,
        ),
    );
  if (substantiveUser) {
    const intent =
      substantiveUser.match(
        /(?:帮我|给我|请)?(.{0,4}(?:删(?:除|掉)|清理|新建|创建|写入|打开|整理|下载|保存)[^，。！？!?]{0,28})/,
      )?.[1] || substantiveUser;
    return { action: clipDetail(intent, 36), objectHint: null };
  }

  return null;
};

const buildActionResumeLine = (
  memory: CyrvisMemorySnapshot,
  previous: string,
): string | null => {
  const work = synthesizeRecentWork(memory);
  if (!work) return null;
  return pickDifferent(
    [
      `上次你让我${work.action}，还需要继续执行吗？`,
      `刚才那件事（${work.action}）告一段落了，还要我接着做吗？`,
      `桌面相关操作已经走到「${work.action}」这一步，需要继续完善吗？`,
    ],
    previous,
  );
};

/** Soft-fill planner from memory after restart (in-memory state is empty). */
const rehydrateTravelFromMemory = (memory: CyrvisMemorySnapshot): void => {
  const snap = travelPlanner.getSnapshot();
  if (snap.framework.destination) return;

  const texts = [
    ...memory.facts.slice(0, 12),
    ...memory.turns.slice(-24).map((turn) => turn.text),
  ];
  for (const text of [...texts].reverse()) {
    const skeleton = text.match(/骨架攻略：([^。\n]+)/)?.[1];
    if (skeleton) {
      travelPlanner.updateFramework({ userText: skeleton });
      if (travelPlanner.getSnapshot().framework.destination) break;
    }
    const dest =
      text.match(
        /去(?:一趟|玩玩|旅游|旅行)?([\u4e00-\u9fa5A-Za-z]{2,12}?)(?:的|玩|旅游|旅行|机票|酒店|滑雪)/,
      )?.[1] ||
      text.match(/出发去([\u4e00-\u9fa5A-Za-z]{2,12})/)?.[1] ||
      text.match(/CYRVIS旅行计划-([\u4e00-\u9fa5A-Za-z]{2,12})/)?.[1];
    if (dest) {
      travelPlanner.updateFramework({
        destination: dest,
        userText: text.slice(0, 120),
      });
      break;
    }
  }

  const preferenceBlob = memory.turns
    .filter((turn) => turn.role === 'user')
    .slice(-8)
    .map((turn) => turn.text)
    .join(' ');
  travelPlanner.syncFromConversation([preferenceBlob]);
};

const buildResumeFromMemoryFallback = (
  memory: CyrvisMemorySnapshot,
): string | null => {
  const work = synthesizeRecentWork(memory);
  if (work) {
    const second =
      work.objectHint && !work.action.includes(work.objectHint)
        ? `当时主要围绕${work.objectHint}在推进`
        : '内容和步骤已经有一部分进展';
    return `上次你让我${work.action}。${second}。需要继续完善这个任务吗？`;
  }

  const recentAssistant = [...memory.turns]
    .reverse()
    .find(
      (turn) => turn.role === 'assistant' && !isLowSignalUtterance(turn.text),
    );
  if (!recentAssistant) return null;
  return `上次我们推进到：${clipDetail(recentAssistant.text, 40)}。需要继续完善这个任务吗？`;
};

/** Launch/activate/resume: summarize last task instead of a bare continue ask. */
const buildLifecycleResumeInvite = (memory: CyrvisMemorySnapshot): string => {
  const recentUserTurns = memory.turns
    .filter((turn) => turn.role === 'user')
    .slice(-8)
    .map((turn) => turn.text.trim())
    .filter(Boolean);
  travelPlanner.syncFromConversation(recentUserTurns);
  rehydrateTravelFromMemory(memory);

  const overview = travelPlanner.buildResumeOverview();
  if (overview) {
    const detailText =
      overview.details.length > 0
        ? `${overview.details.join('。')}。`
        : '框架和偏好还记得一部分，具体方案还可以接着补。';
    return `${overview.headline}。${detailText}需要继续完善这个任务吗？`;
  }

  return (
    buildResumeFromMemoryFallback(memory) ||
    '上次的事情还留着一点尾巴。需要继续完善这个任务吗？'
  );
};

const buildContextualSuggestion = (
  memory: CyrvisMemorySnapshot,
  previous: string,
): string => {
  // Only USER turns — assistant menus like “美食、打卡…” must not lock preference.
  const recentUserTurns = memory.turns
    .filter((turn) => turn.role === 'user')
    .slice(-6)
    .map((turn) => turn.text.trim())
    .filter(Boolean);
  travelPlanner.syncFromConversation(recentUserTurns);
  const travelHint = travelPlanner.buildIdleSuggestion(recentUserTurns);
  if (travelHint) {
    // Never emit a near-duplicate idle prompt.
    const norm = (text: string) => text.replace(/\s+/g, '');
    if (previous && norm(travelHint) === norm(previous)) {
      return pickDifferent(
        [
          '要不要我直接给你两个能落地的具体推荐？',
          '我可以先出一个可执行小方案，你觉得不对再改。',
          '这一段我们先停一下也行，想到细节再说。',
        ],
        previous,
      );
    }
    if (
      previous &&
      (norm(travelHint).includes(norm(previous).slice(0, 16)) ||
        norm(previous).includes(norm(travelHint).slice(0, 16)))
    ) {
      return pickDifferent(
        [
          '我直接给你具体点位吧，还是你想先换个方向？',
          '要不我按你刚才说的，先推荐住宿或行程里的可选项。',
        ],
        previous,
      );
    }
    return travelHint;
  }

  const lastUser = [...memory.turns]
    .reverse()
    .find((turn) => turn.role === 'user');
  if (!lastUser) {
    return pickDifferent(
      [
        '刚才的任务告一段落了，要不要告诉我接下来想往哪个方向推进？',
        '要不要继续刚才的工作？我也可以先帮你整理一个下一步清单。',
      ],
      previous,
    );
  }

  // Look past status-check lines — summarize earlier substance + activities.
  const recentUserBlob = memory.turns
    .filter((turn) => turn.role === 'user')
    .slice(-8)
    .map((turn) => turn.text)
    .join(' ');
  const recentActivities = memory.activities
    .slice(-8)
    .map((activity) => activity.text)
    .join(' ');
  const recentAssistantBlob = memory.turns
    .filter((turn) => turn.role === 'assistant')
    .slice(-4)
    .map((turn) => turn.text)
    .join(' ');
  const context = `${recentUserBlob} ${recentActivities} ${recentAssistantBlob}`;

  if (/(删|删除|清理).{0,12}(桌面|文件|文件夹|计划)/.test(context)) {
    const actionLine = buildActionResumeLine(memory, previous);
    if (actionLine) return actionLine;
    return pickDifferent(
      [
        '上次你让我处理桌面上的文件，还需要继续执行吗？',
        '桌面文件相关操作告一段落了，还要我接着做吗？',
      ],
      previous,
    );
  }

  const bookTitle = context.match(/《([^》]{1,30})》/)?.[1];
  const poemTitle =
    bookTitle || context.match(/(满江红|沁园春|念奴娇|水调歌头)/)?.[1];

  if (
    poemTitle ||
    /(古诗|诗词|这首诗|这首词|文言文|唐诗|宋词|岳飞)/.test(context)
  ) {
    const topic = poemTitle ? `《${poemTitle}》` : '刚才这篇诗词';
    return pickDifferent(
      [
        `刚才我们处理了${topic}，要不要我接着讲讲它的创作背景和逐句翻译？`,
        `关于${topic}，下一步要不要做一份赏析，看看意象、情感和写作手法？`,
        `${topic}已经有了基础内容，要不要我再帮你整理主旨、名句和考试常见考点？`,
      ],
      previous,
    );
  }

  if (/(代码|程序|项目|报错|bug|接口|API|开发|实现|修复)/i.test(context)) {
    return pickDifferent(
      [
        '刚才的开发任务有了进展，要不要我接着跑一遍测试并检查边界情况？',
        '下一步要不要我把刚才的代码改动整理成说明，再检查有没有遗漏？',
        '要不要继续验证刚才的功能？我可以顺便排查性能和异常处理。',
      ],
      previous,
    );
  }

  if (/(论文|作业|报告|文章|文档|申请|简历|演讲稿|写一篇)/.test(context)) {
    return pickDifferent(
      [
        '刚才的文字内容已经有了基础，要不要我接着帮你润色结构和表达？',
        '下一步要不要检查论点、格式和引用，再补一版更精炼的摘要？',
        '要不要我根据刚才的内容做一次校对，并整理成可以直接提交的版本？',
      ],
      previous,
    );
  }

  if (/(搜索|查找|研究|资料|对比|调研|分析)/.test(context)) {
    return pickDifferent(
      [
        '刚才查到的信息要不要继续整理成要点，并比较一下不同来源的结论？',
        '下一步要不要我把调研结果汇总成一张清晰的对比表？',
        '资料已经有了一些，要不要我继续提炼结论和可执行建议？',
      ],
      previous,
    );
  }

  if (/(旅行|出行|行程|计划|安排|日程|清单)/.test(context)) {
    return pickDifferent(
      [
        '刚才的计划要不要继续拆成时间表和待办清单？',
        '下一步要不要我检查时间冲突，再给你准备一个备用方案？',
        '要不要把刚才的安排整理成一份更容易执行的行动清单？',
      ],
      previous,
    );
  }

  // Never echo the latest user utterance (e.g. “你好，你删除了吗”) as the topic.
  const actionLine = buildActionResumeLine(memory, previous);
  if (actionLine) return actionLine;

  return pickDifferent(
    [
      '刚才那件事已经有了结果，还需要我继续执行吗？',
      '上一步已经做完了，要不要我根据进度接着推进？',
      '这边可以继续帮你收尾，需要我接着做吗？',
    ],
    previous,
  );
};

const followUpStore = new ElectronStore<FollowUpState>({
  name: 'cyrvis-proactivity',
  defaults: {
    enabled: true,
    snoozedUntil: 0,
    lastPromptAt: 0,
    lastGreeting: '',
    pending: null,
  },
});

let registered = false;
let idleSuggestionShown = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let localSpeechProcess: ChildProcess | null = null;
let lastLifecyclePromptAt = 0;
let lastIdleSourceAt = 0;
let idleCheckRunning = false;

const speakLocally = (text: string): void => {
  // macOS fallback only — Windows uses the realtime voice session.
  if (process.platform !== 'darwin') {
    logger.warn(
      '[cyrvis follow-up] local TTS skipped on this platform; showing text only',
    );
    return;
  }
  localSpeechProcess?.kill();
  localSpeechProcess = execFile(
    '/usr/bin/say',
    ['-v', 'Tingting', '-r', '185', text],
    (error) => {
      localSpeechProcess = null;
      if (!error) return;
      logger.warn('[cyrvis follow-up] Chinese voice unavailable', error);
      localSpeechProcess = execFile('/usr/bin/say', ['-r', '180', text], () => {
        localSpeechProcess = null;
      });
    },
  );
};

const stopLocalSpeech = (): void => {
  if (localSpeechProcess && !localSpeechProcess.killed) {
    localSpeechProcess.kill();
    localSpeechProcess = null;
  }
};

const enrichAndSpeak = async (prompt: FollowUpPrompt): Promise<void> => {
  const pending = followUpStore.get('pending');
  if (!pending || pending.id !== prompt.id) return;

  const now = new Date(prompt.createdAt);
  const yesterdayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  ).getTime();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const memory = await voiceMemoryService.getSnapshot();
  const latestPending = followUpStore.get('pending');
  if (!latestPending || latestPending.id !== prompt.id) return;
  const yesterdayItems = [...memory.turns, ...memory.activities].filter(
    (item) => item.createdAt >= yesterdayStart && item.createdAt < todayStart,
  ).length;
  const previousGreeting = followUpStore.get('lastGreeting');
  const greeting =
    prompt.reason === 'idle'
      ? buildContextualSuggestion(memory, previousGreeting)
      : createGreeting(now, yesterdayItems >= 8, previousGreeting);
  const resumeInvite =
    prompt.reason === 'idle' ? '' : buildLifecycleResumeInvite(memory);
  // Lifecycle speech = short hello + task summary + continue ask (not bare).
  const speech =
    prompt.reason === 'idle' ? greeting : `${greeting}${resumeInvite}`;

  const enriched = {
    ...prompt,
    greeting: speech,
  };
  followUpStore.set({
    ...followUpStore.store,
    lastGreeting: speech,
    pending: enriched,
  });

  // Always mirror proactive lines into the transcript/memory.
  publishProactiveText(speech);
  if (!speakProactiveText(speech)) {
    speakLocally(speech);
  }
  followUpStore.set('pending', null);
};

export const requestFollowUp = (
  reason: FollowUpReason,
  options: { force?: boolean } = {},
): FollowUpPrompt | null => {
  const now = Date.now();
  const enabled = followUpStore.get('enabled');
  const snoozedUntil = followUpStore.get('snoozedUntil');
  const lastPromptAt = followUpStore.get('lastPromptAt');

  if (
    !enabled ||
    now < snoozedUntil ||
    (!options.force && now - lastPromptAt < PROMPT_GAP_MS)
  ) {
    return null;
  }

  const prompt: FollowUpPrompt = {
    id: `${reason}-${now}`,
    reason,
    createdAt: now,
    greeting: '',
  };
  if (reason !== 'idle') lastLifecyclePromptAt = now;
  followUpStore.set({
    ...followUpStore.store,
    lastPromptAt: now,
    pending: prompt,
  });

  void enrichAndSpeak(prompt);
  logger.info('[cyrvis follow-up] prompt', prompt);
  return prompt;
};

export const registerFollowUpService = (): void => {
  if (registered) return;
  registered = true;

  ipcMain.handle('cyrvis:follow-up:get-pending', () =>
    followUpStore.get('pending'),
  );
  ipcMain.handle('cyrvis:follow-up:complete', (_event, id: unknown) => {
    stopLocalSpeech();
    const pending = followUpStore.get('pending');
    if (!pending || pending.id === id) followUpStore.set('pending', null);
    return { ok: true };
  });
  ipcMain.handle(
    'cyrvis:follow-up:snooze',
    (_event, id: unknown, delayMs: unknown) => {
      stopLocalSpeech();
      const pending = followUpStore.get('pending');
      if (!pending || pending.id === id) followUpStore.set('pending', null);
      const safeDelay =
        typeof delayMs === 'number' && delayMs > 0
          ? Math.min(delayMs, 24 * 60 * 60 * 1000)
          : DEFAULT_SNOOZE_MS;
      followUpStore.set('snoozedUntil', Date.now() + safeDelay);
      return { ok: true, snoozedUntil: followUpStore.get('snoozedUntil') };
    },
  );

  const requestLifecycleFollowUp = (reason: FollowUpReason): void => {
    const now = Date.now();
    if (now - lastLifecyclePromptAt < LIFECYCLE_DEDUPE_MS) return;
    requestFollowUp(reason, { force: true });
  };

  powerMonitor.on('resume', () => requestLifecycleFollowUp('resume'));
  powerMonitor.on('unlock-screen', () => requestLifecycleFollowUp('unlock'));

  // Treat a lack of keyboard/mouse activity as a short pause in the user's
  // workflow. Only prompt once per idle episode and never stack dialogs.
  idleTimer = setInterval(() => {
    if (idleCheckRunning) return;
    idleCheckRunning = true;
    void (async () => {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (idleSeconds < IDLE_SUGGESTION_SECONDS) {
        idleSuggestionShown = false;
        return;
      }
      if (followUpStore.get('pending')) return;

      const memory = await voiceMemoryService.getSnapshot();
      const lastUserAt = memory.turns
        .filter((turn) => turn.role === 'user')
        .reduce((latest, turn) => Math.max(latest, turn.createdAt), 0);
      const lastActivityAt = memory.activities.reduce(
        (latest, activity) => Math.max(latest, activity.createdAt),
        0,
      );
      const sourceAt = Math.max(lastUserAt, lastActivityAt);

      // Voice activity does not reset macOS's keyboard/mouse idle clock. Start
      // the 10-second window from the latest conversation/task event as well.
      if (
        sourceAt > 0 &&
        Date.now() - sourceAt < IDLE_SUGGESTION_SECONDS * 1000
      ) {
        idleSuggestionShown = false;
        return;
      }
      if (sourceAt > lastIdleSourceAt) idleSuggestionShown = false;
      if (
        idleSuggestionShown ||
        (sourceAt > 0 && sourceAt <= lastIdleSourceAt)
      ) {
        return;
      }

      // Do not follow a launch/wake greeting with another generic prompt. A new
      // user turn or task event bypasses this grace period and gets its normal
      // 10-second contextual suggestion.
      if (
        Date.now() - lastLifecyclePromptAt < IDLE_AFTER_GREETING_MS &&
        sourceAt <= lastLifecyclePromptAt
      ) {
        return;
      }

      const prompt = requestFollowUp('idle', {
        force: true,
      });
      if (prompt) {
        idleSuggestionShown = true;
        lastIdleSourceAt = sourceAt || Date.now();
      }
    })()
      .catch((error) => {
        logger.warn('[cyrvis follow-up] idle check failed', error);
      })
      .finally(() => {
        idleCheckRunning = false;
      });
  }, 1000);

  app.once('before-quit', () => {
    stopLocalSpeech();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  });
};
