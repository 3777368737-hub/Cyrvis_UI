/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';

import type { CyrvisController } from './controller';
import { TaskBusyError } from './controller';
import type { CodingAgentService, CodingTaskSnapshot } from './coding-agent';
import type { AllowedApp, SearchEngine } from './desktop-actions';
import { buildSearchUrl, defaultSearchEngine } from './navigation';
import { resolveSite, buildSiteSearchUrl } from './site-registry';
import { NAVIGATION_TOOL_ALIASES } from './voice/tool-surface';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import { classifyVoiceIntent, type VoiceIntentDecision } from './search-intent';
import { TaskConversationCoordinator } from './task-conversation';
import {
  isExplicitTravelGuiRequest,
  isTravelPlanningText,
  travelPlanner,
} from './travel/travel-planner';
import {
  appendTravelMemo,
  writeTravelPlanDesktopTxt,
} from './travel/travel-memo';
import {
  buildTravelSearchQuery,
  hitsToSnippets,
  probeTravelHighlights,
  searchTravelInfo,
} from './travel/travel-search';
import type { ControllerEvent } from './types';
import {
  SENSITIVE_CONFIRMATION_PROMPT,
  extractBrowserSearchQuery,
  type FastToolRouter,
} from './tools';
import type { CyrvisVoiceState } from '@shared/cyrvis';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import type {
  PendingIntentDecision,
  PendingIntentInput,
} from './voice/pending-intent-classifier';
import type { TravelPlanSnapshot } from './travel/travel-planner';

export type VoiceBrainState = CyrvisVoiceState;

/** Compact travel tool payloads so the voice model does not stall on huge JSON. */
const slimTravelResult = (
  snapshot: TravelPlanSnapshot,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ok: true,
  phase: snapshot.phase,
  missingFramework: snapshot.missingFramework,
  nextQuestion: snapshot.nextQuestion,
  primaryInterest: snapshot.primaryInterest,
  interestLabel: snapshot.interestLabel,
  preferredNextAspect: snapshot.preferredNextAspect,
  softBridge: snapshot.softBridge,
  speakHint: snapshot.speakHint,
  skeleton: snapshot.skeleton,
  ...extra,
});

export interface VoiceBrainCallbacks {
  onAudio?: (pcm16: Int16Array) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscript?: (text: string, final: boolean) => void;
  onAssistantText?: (text: string, final: boolean) => void;
  onSpeechText?: (text: string, final: boolean) => void;
  onState?: (state: VoiceBrainState) => void;
  onWake?: () => void;
  onSleep?: () => void;
  onTaskEvent?: (event: ControllerEvent) => void;
  /** The ASR transcript is almost certainly the assistant's own speaker audio. */
  onSelfEcho?: () => void;
  onError?: (error: Error) => void;
}

export interface VoiceBrainOptions {
  requireWakeWord?: boolean;
  awakeTimeoutMs?: number;
  wakePatterns?: RegExp[];
  enableProactivity?: boolean;
  /** A clear task/control command can wake the assistant without the wake word. */
  autoWakeOnTask?: boolean;
  proactivity?: ProactivityOptions;
  memoryContextProvider?: () => Promise<string>;
  rememberFact?: (text: string) => Promise<string | null>;
  fastToolRouter?: FastToolRouter;
  codingAgent?: CodingAgentService;
  classifyPendingIntent?: (
    input: PendingIntentInput,
  ) => Promise<PendingIntentDecision>;
}

const DEFAULT_WAKE_PATTERNS: RegExp[] = [
  /\b(hello|hallo|hi|hey|ok)[\s,，]*(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|sirvis|cervis|sirius|siris|service|zawis|zavis|savis|cywiz|cy vis)\b/i,
  /\b(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|zawis|zavis|savis|savage|savages|s voice|svoice)\b/i,
  /\b(hello|hallo|hi|hey)\b/i,
  /(你好|您好|嗨|哈喽|哈啰|哈罗)/,
  /(你好|您好|嗨|喂|哈喽|哈啰|哈罗)[，,\s]*(cyrvis|赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞浦路斯|塞维斯)/i,
  /(赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞维斯)/i,
];

const USER_RESPONSE_FALLBACK_MS = 6000;

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：""''“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeTranscriptDedupeKey = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');

/**
 * A search intent that also needs real page interaction (click a result,
 * book a flight, fill a form) is still a GUI task. Plain lookup/search must
 * go through search_web instead.
 */
const GUI_INTERACTION_PATTERNS: RegExp[] = [
  /(点击|点一下|双击|选择|预订|下单|填写|登录|滚动|比较|对比|查看页面|截图|截屏|加入购物车|支付|购买|提交|确认订单)/,
  /\b(click|select|book|order|fill|login|scroll|compare|screenshot|add to cart|pay|purchase|submit)\b/i,
];

const shouldClassifyPendingReply = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed || Array.from(trimmed).length > 40) {
    return false;
  }
  return /(?:对|是|好|行|嗯|可以|确认|执行|删|取消|不要|不是|别|yes|no|ok|continue)/i.test(
    trimmed,
  );
};

/**
 * The conversational brain.
 *
 * Responsibilities:
 * - wake/sleep gating for "Hello CYRVIS";
 * - route tool calls through the intent gate before touching the GUI agent;
 * - drop audio/tool calls while asleep;
 * - translate Controller events into proactive speech.
 */
export class VoiceBrain {
  private readonly provider: VoiceProvider;
  private readonly proactivity: ProactivityPolicy;
  private readonly taskConversation: TaskConversationCoordinator;
  private awake = false;
  private userSpeaking = false;
  private ttsSpeaking = false;
  private userSpeechStartedAt = 0;
  private lastUserSpeechAt = 0;
  private lastUserSpeechDurationMs = 0;
  private lastUserText = '';
  private lastVoiceIntent: VoiceIntentDecision | null = null;
  private lastActionableUserText = '';
  private conversationConfirmationUntil = 0;
  private partialUserText = '';
  private assistantTextBuffer = '';
  private lastFinalTranscript = '';
  private lastFinalAt = 0;
  private suppressAudioUntilResponseDone = false;
  private completionGuardTriggered = false;
  private awakeTimer: ReturnType<typeof setTimeout> | null = null;
  private speakWatchdog: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
  private responseHadAudio = false;
  private responseHadText = false;
  private responseHadSpeechOutput = false;
  private currentResponseText = '';
  private userResponseWatchdog: ReturnType<typeof setTimeout> | null = null;
  private waitingForUserResponse = false;
  private userResponseOutputSeen = false;
  private lastAssistantText = '';
  private lastAssistantAudioAt = 0;
  // After a bare "停/暂停", do not let the model speak an acknowledgment.
  // The user expects the audio to stop, not a new reply confirming it.
  private suppressReplyUntil = 0;
  private stopToolGuardUntil = 0;
  private taskSpeechGuardUntil = 0;
  private pendingBargeStopAt = 0;
  private lastDeterministicControl: {
    kind: 'cancel' | 'pause';
    at: number;
  } | null = null;
  private fastToolGuardUntil = 0;
  private deterministicFastToolGuardUntil = 0;
  private codingToolGuardUntil = 0;
  private codingFileNames = new Set<string>();
  private lastCodingProgressAt = 0;
  private lastCodingProgressMessage = '';
  private lastHardStopAt = 0;
  private navigationExecutions = new Set<string>();
  private readonly unsubscribeController: () => void;
  private readonly completionClaimPattern =
    /(已经打开|已经输入|已经完成|已完成|完成了|打开了|输入了|opened|typed|completed|finished|done|succeeded)/i;

  private readonly requireWakeWord: boolean;
  private readonly awakeTimeoutMs: number;
  private readonly wakePatterns: RegExp[];

  constructor(
    private readonly controller: CyrvisController,
    private readonly callbacks: VoiceBrainCallbacks = {},
    providerFactory: (callbacks: VoiceProviderCallbacks) => VoiceProvider,
    private readonly options: VoiceBrainOptions = {},
  ) {
    this.requireWakeWord = options.requireWakeWord ?? true;
    this.awakeTimeoutMs = options.awakeTimeoutMs ?? 20_000;
    this.wakePatterns = options.wakePatterns || DEFAULT_WAKE_PATTERNS;

    this.provider = providerFactory(this.createProviderCallbacks());

    this.proactivity = new ProactivityPolicy(
      (utterance) => {
        if (!this.awake) {
          return;
        }
        this.speak(utterance.text);
      },
      {
        // Qwen acknowledges a successful tool call by itself; do not double-ack.
        acknowledgeOnStart: false,
        enableProgress: false,
        enableSuggestions: false,
        ...options.proactivity,
      },
    );
    this.taskConversation = new TaskConversationCoordinator({
      speak: (text) => {
        if (!this.awake) {
          this.wake();
        }
        // Task progress/status speech is proactive; in speaker mode its own
        // echo must not trigger an energy barge that kills the task. KWS
        // stop words still bypass this guard.
        this.taskSpeechGuardUntil = Date.now() + 1_800;
        this.speak(text);
      },
      clearSpeech: () => this.provider.cancelPendingSpeech?.(),
      getStatus: () => this.controller.getStatus(),
    });

    this.unsubscribeController = controller.onEvent((event) => {
      this.callbacks.onTaskEvent?.(event);
      this.taskConversation.onEvent(event);
      this.notifyState();
    });
  }

  async start(): Promise<void> {
    if (this.provider.setContext) {
      const memoryContext =
        (await this.options
          .memoryContextProvider?.()
          .catch((error: unknown) => {
            console.warn('[cyrvis memory] context load failed', error);
            return '';
          })) || '';
      this.provider.setContext(memoryContext);
    }
    await this.provider.connect();
    if (!this.requireWakeWord) {
      this.wake();
    }
    this.notifyState();
  }

  getState(): VoiceBrainState {
    return {
      awake: this.awake,
      userSpeaking: this.userSpeaking,
      ttsSpeaking: this.ttsSpeaking,
      lastUserText: this.lastUserText,
      task: this.controller.getStatus(),
    };
  }

  forceAwake(): void {
    this.wake();
  }

  isTaskSpeechActive(): boolean {
    return Date.now() < this.taskSpeechGuardUntil;
  }

  shouldSuppressReply(): boolean {
    return Date.now() < this.suppressReplyUntil;
  }

  private clearUserResponseWatchdog(): void {
    if (this.userResponseWatchdog) {
      clearTimeout(this.userResponseWatchdog);
      this.userResponseWatchdog = null;
    }
  }

  private markUserResponseOutput(): void {
    this.userResponseOutputSeen = true;
    this.waitingForUserResponse = false;
    this.clearUserResponseWatchdog();
    this.taskConversation.dispose();
  }

  private armUserResponseWatchdog(): void {
    this.clearUserResponseWatchdog();
    this.waitingForUserResponse = true;
    this.userResponseOutputSeen = false;
    this.userResponseWatchdog = setTimeout(() => {
      this.userResponseWatchdog = null;
      if (
        !this.waitingForUserResponse ||
        this.userResponseOutputSeen ||
        this.shouldSuppressReply()
      ) {
        return;
      }
      const taskActive = ['starting', 'executing', 'paused'].includes(
        this.controller.getStatus().status,
      );
      this.markUserResponseOutput();
      this.speak(
        taskActive
          ? '我在处理，请稍等，完成后我会告诉你。'
          : '我在，正在理解你的请求，请稍等。',
      );
    }, USER_RESPONSE_FALLBACK_MS);
  }

  /**
   * Any confirmed barge is a stop request, even when ASR returns empty or
   * mishears "停". Cancel the current response and keep the model silent for
   * a short window so it cannot answer with "好的，已暂停…".
   */
  markUserStop(): void {
    // Qwen can start a follow-up response 2-3s after the barge audio was
    // cancelled. 3s covers the observed 2.3s follow-up while still allowing
    // a real new command to clear the window immediately.
    this.suppressReplyUntil = Date.now() + 3000;
    this.stopToolGuardUntil = Date.now() + 3000;
    this.clearUserResponseWatchdog();
    this.waitingForUserResponse = false;
  }

  /**
   * Deterministic barge stop. Do not wait for ASR: a confirmed barge may be a
   * short "停" that the model hears as empty or something else several seconds
   * later. Pause the GUI task and keep the assistant silent.
   */
  handleBargeStop(_hardStop = false): void {
    // Any confirmed barge is a stop, not a pause. KWS recall is not reliable
    // enough on this Bluetooth/headset path; depending on it left tasks
    // running after several "停一下" attempts. Cancel the task immediately
    // when the user starts speaking over the assistant.
    this.handleStopCommand();
  }

  sleep(): void {
    if (!this.awake) {
      return;
    }
    this.awake = false;
    this.clearAwakeTimer();
    this.clearUserResponseWatchdog();
    this.callbacks.onSleep?.();
    this.notifyState();
  }

  dispose(): void {
    this.clearAwakeTimer();
    this.clearPlaybackWatchdog();
    this.clearUserResponseWatchdog();
    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
      this.speakWatchdog = null;
    }
    this.unsubscribeController();
    this.proactivity.reset();
    this.provider.close();
  }

  private createProviderCallbacks(): VoiceProviderCallbacks {
    return {
      onReady: () => {
        if (!this.requireWakeWord) {
          this.wake();
        }
        this.notifyState();
      },
      onClose: () => {
        this.sleep();
        this.notifyState();
      },
      onSpeechStarted: () => {
        this.userSpeaking = true;
        this.userSpeechStartedAt = Date.now();
        this.ttsSpeaking = false;
        this.clearPlaybackWatchdog();
        this.proactivity.setUserSpeaking(true);
        this.proactivity.setTtsSpeaking(false);
        this.callbacks.onSpeechStarted?.();
        this.notifyState();
      },
      onSpeechStopped: () => {
        this.userSpeaking = false;
        this.lastUserSpeechAt = Date.now();
        this.lastUserSpeechDurationMs = this.userSpeechStartedAt
          ? this.lastUserSpeechAt - this.userSpeechStartedAt
          : 0;
        this.proactivity.setUserSpeaking(false);
        this.callbacks.onSpeechStopped?.();
        this.notifyState();
      },
      onTranscript: (text, final) => this.handleTranscript(text, final),
      onAssistantText: (text, final) => {
        if (this.shouldSuppressReply()) {
          return;
        }
        if (text.trim()) {
          this.responseHadText = true;
          this.taskConversation.noteAssistantOutput();
          this.currentResponseText = final
            ? text
            : `${this.currentResponseText}${text}`;
          this.markUserResponseOutput();
        }
        if (final && text.trim()) {
          this.lastAssistantText = text;
          if (/确认执行|是否执行|是否确认|需要确认|请确认|确认吗/i.test(text)) {
            this.conversationConfirmationUntil = Date.now() + 120_000;
          }
        }
        this.guardCompletionClaim(text);
        this.callbacks.onAssistantText?.(text, final);
      },
      onSpeechText: (text, final) => {
        if (!this.shouldSuppressReply()) {
          if (text.trim()) {
            this.responseHadSpeechOutput = true;
            this.taskConversation.noteAssistantOutput();
            this.markUserResponseOutput();
          }
          this.callbacks.onSpeechText?.(text, final);
        }
      },
      onToolCall: (call) => {
        void this.handleToolCall(call).catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      },
      onAudio: (pcm16) => {
        this.responseHadAudio = true;
        this.taskConversation.noteAssistantOutput();
        this.markUserResponseOutput();
        this.lastAssistantAudioAt = Date.now();
        if (
          this.awake &&
          !this.suppressAudioUntilResponseDone &&
          !this.shouldSuppressReply()
        ) {
          this.callbacks.onAudio?.(pcm16);
        }
      },
      onResponseStarted: () => {
        if (this.shouldSuppressReply()) {
          console.log('[cyrvis voice] suppressed reply after stop command');
          this.provider.cancelResponse();
          return;
        }
        this.assistantTextBuffer = '';
        this.completionGuardTriggered = false;
        this.suppressAudioUntilResponseDone = false;
        this.responseHadAudio = false;
        this.responseHadText = false;
        this.responseHadSpeechOutput = false;
        this.currentResponseText = '';
        this.taskConversation.noteAssistantOutput();
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = true;
        this.proactivity.setTtsSpeaking(true);
        this.notifyState();
      },
      onResponseDone: () => {
        const textOnlyFallback =
          !this.suppressAudioUntilResponseDone &&
          !this.shouldSuppressReply() &&
          this.responseHadText &&
          !this.responseHadAudio &&
          !this.responseHadSpeechOutput;
        const fallbackText = this.currentResponseText.trim();
        const hadAudio = this.responseHadAudio;
        this.assistantTextBuffer = '';
        this.suppressAudioUntilResponseDone = false;
        this.completionGuardTriggered = false;
        this.responseHadAudio = false;
        this.responseHadText = false;
        this.responseHadSpeechOutput = false;
        this.currentResponseText = '';
        this.resetAwakeTimer();
        if (hadAudio) {
          // The server finished generating audio, but the renderer is still
          // playing the WAV queue. Keep ttsSpeaking=true so proactive lines
          // cannot start a second response and cut this one off.
          this.armPlaybackWatchdog();
        } else {
          this.ttsSpeaking = false;
          this.proactivity.setTtsSpeaking(false);
          this.clearPlaybackWatchdog();
        }
        this.notifyState();
        if (textOnlyFallback && fallbackText) {
          setTimeout(() => {
            if (!this.shouldSuppressReply()) {
              this.speak(fallbackText);
            }
          }, 50);
        }
      },
      onPlaybackIdle: () => {
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
        this.notifyState();
      },
      onError: (error) => {
        this.callbacks.onError?.(error);
        if (this.waitingForUserResponse && !this.userResponseOutputSeen) {
          this.markUserResponseOutput();
          this.speak('抱歉，刚才没有成功生成回复，请再说一遍。');
        }
      },
    };
  }

  private handleTranscript(text: string, final: boolean): boolean {
    this.callbacks.onTranscript?.(text, final);

    if (!final) {
      this.partialUserText += text;
      // "停一下" is short enough that the final transcript may arrive after
      // the GUI/coding task has already taken another action. Act on the
      // partial as soon as it is unambiguous. A pending sensitive-action
      // confirmation keeps "取消" for its own cancel path.
      if (
        this.isStopCommand(this.partialUserText) &&
        this.options.fastToolRouter?.hasPendingConfirmation() !== true
      ) {
        this.partialUserText = '';
        this.handleStopCommand();
        return true;
      }
      if (!this.awake && this.isWakePhrase(this.partialUserText)) {
        this.wake();
      }
      return false;
    }

    this.partialUserText = '';

    if (!text.trim()) {
      // Empty finals are server-side VAD noise or a dropped short word. The
      // barge/KWS path already handles real stops; cancelling here cut every
      // ongoing answer after a few words. Ignore them entirely.
      console.log('[cyrvis voice] empty transcript ignored', {
        sinceSpeechMs: this.lastUserSpeechAt
          ? Date.now() - this.lastUserSpeechAt
          : null,
        speechMs: this.lastUserSpeechDurationMs,
      });
      return true;
    }

    // ASR often truncates "停下" to "下" or "停" when the user talks over the
    // assistant. If a barge just paused a task and the final transcript is a
    // stop-word fragment, treat it as a hard stop instead of leaving a paused
    // GUI task behind.
    const bargeStopRecent =
      this.pendingBargeStopAt > 0 &&
      Date.now() - this.pendingBargeStopAt < 3_000;
    if (bargeStopRecent && this.isStopFragment(text)) {
      this.pendingBargeStopAt = 0;
      this.handleStopCommand();
      return true;
    }
    this.pendingBargeStopAt = 0;

    // A transcript that starts with a stop word is a stop, full stop.
    // The remainder may be the assistant's own TTS echo picked up by ASR
    // ("停一下，现在这样，打开B站…"), so it must never be re-routed as a new
    // command in the same turn. Ask the user to repeat a new command after the
    // stop if they actually want one.
    const leadingStop =
      /^(?:呃|啊|哦|嗯|唉|诶|好|ok)?[，,\s]*(先停一下|先停|停一下|停一停|停下来|停下|停止|停|别说了|不要说了|取消|算了|stop|cancel|abort)[，,\s]*(.*)$/i.exec(
        text,
      );
    if (
      leadingStop &&
      this.options.fastToolRouter?.hasPendingConfirmation() !== true
    ) {
      this.handleStopCommand();
      return true;
    }
    if (
      this.isStopCommand(text) &&
      this.options.fastToolRouter?.hasPendingConfirmation() !== true
    ) {
      this.handleStopCommand();
      return true;
    }

    if (this.handleContinueCommand(text)) {
      return true;
    }

    const now = Date.now();
    const transcriptKey = normalizeTranscriptDedupeKey(text);
    if (
      transcriptKey &&
      transcriptKey === this.lastFinalTranscript &&
      now - this.lastFinalAt < 750
    ) {
      console.log('[cyrvis voice] duplicate transcript ignored');
      return true;
    }
    this.lastFinalTranscript = transcriptKey;
    this.lastFinalAt = now;
    this.navigationExecutions = new Set();

    const pending = this.options.fastToolRouter?.getPendingConfirmation();
    if (
      pending &&
      this.options.classifyPendingIntent &&
      this.options.fastToolRouter?.canHandle(text) !== true &&
      shouldClassifyPendingReply(text)
    ) {
      this.lastUserText = text;
      this.armUserResponseWatchdog();
      this.notifyState();
      this.handleSemanticPendingReply(text, pending);
      return true;
    }

    const voiceIntent = classifyVoiceIntent(text);
    this.lastVoiceIntent = voiceIntent;
    const semanticMode =
      voiceIntent.mode === 'answer' ||
      voiceIntent.mode === 'search' ||
      voiceIntent.mode === 'compare' ||
      (voiceIntent.mode === 'navigate' && voiceIntent.targetKind === 'site');
    // The semantic layer owns answers, navigation, search and comparison. Do
    // not let the dynamic fast-tool router consume those turns.
    const canHandleFastTool =
      !semanticMode && this.options.fastToolRouter?.canHandle(text) === true;
    const explicitConfirmation =
      this.options.fastToolRouter?.isConfirmationIntent(text) === true;

    // Speaker mode: the mic can pick up the assistant's own voice. If ASR
    // returns a short echo of the last reply ("我在", "我来", "我"), do not
    // start another turn; otherwise the model answers itself forever.
    // Pending confirmation is explicit control input and must bypass this
    // filter because the assistant itself just spoke "confirm execution".
    if (
      !canHandleFastTool &&
      !explicitConfirmation &&
      this.isSelfEchoTranscript(text)
    ) {
      console.log('[cyrvis voice] self-echo transcript ignored', text);
      this.callbacks.onSelfEcho?.();
      this.provider.cancelResponse();
      return true;
    }

    this.lastUserText = text;
    if (voiceIntent.mode !== 'chat') {
      console.log(
        '[cyrvis intent]',
        JSON.stringify({
          mode: voiceIntent.mode,
          query: voiceIntent.query,
          target: voiceIntent.target,
          targetKind: voiceIntent.targetKind,
          silent: voiceIntent.silent,
          siteSearch: voiceIntent.siteSearch === true,
          confidence: voiceIntent.confidence,
          reason: voiceIntent.reason,
        }),
      );
    }

    if (!canHandleFastTool) {
      this.deterministicFastToolGuardUntil = 0;
      this.fastToolGuardUntil = 0;
    }

    // After a stop, a real new command should not be delayed by the 3s
    // anti-acknowledgment window. Numeric/short fragments are usually TTS
    // echo or noise, so they do not clear it.
    if (this.shouldSuppressReply()) {
      const trimmed = text.trim();
      if (
        canHandleFastTool ||
        (trimmed.length >= 3 && !/^\d+$/.test(trimmed))
      ) {
        this.suppressReplyUntil = 0;
        this.stopToolGuardUntil = 0;
        console.log('[cyrvis voice] new command after stop; allowing reply');
      }
    }

    const bareStop =
      /^(停|停下|停止|暂停|停一下|停一停|先停|先停一下|别说了|不要说了|stop|cancel)[。！!，,\s]*$/i.test(
        text.trim(),
      );

    if (!this.awake) {
      const decision = classifyIntent(text);
      const autoWake =
        this.options.autoWakeOnTask !== false &&
        (decision.kind === 'task' ||
          decision.kind === 'control' ||
          canHandleFastTool ||
          ((voiceIntent.mode === 'search' ||
            voiceIntent.mode === 'compare' ||
            voiceIntent.mode === 'answer') &&
            voiceIntent.confidence === 'high'));
      if (this.isWakePhrase(text) || autoWake) {
        this.wake();
      } else {
        // The model may already be answering background speech. Suppress it.
        console.log('[cyrvis voice] asleep; transcript ignored', text);
        this.provider.cancelResponse();
        return true;
      }
      this.notifyState();
    }

    if (!bareStop) {
      this.armUserResponseWatchdog();
    }

    const isStatusQuery = this.isTaskStatusQuery(text);
    if (!explicitConfirmation && !bareStop && !isStatusQuery) {
      this.lastActionableUserText = text;
      this.conversationConfirmationUntil = 0;
    }

    if (
      explicitConfirmation &&
      !canHandleFastTool &&
      Date.now() < this.conversationConfirmationUntil &&
      this.tryRecoveredConfirmation()
    ) {
      return true;
    }

    if (isStatusQuery && this.handleTaskStatusQuery(text)) {
      return true;
    }

    // Code-file creation/execution is deterministic enough to route before
    // the model can mistake it for a Notepad/desktop task.
    if (this.handleCodingCommand(text)) {
      return true;
    }

    // A deterministic fast command owns this turn before the broader GUI
    // control/verb heuristics run.
    if (canHandleFastTool && this.handleFastToolCommand(text)) {
      return true;
    }

    // Safety-critical: stop/pause must act even if the voice model forgets to
    // call the tool (observed in real testing: it said "paused" but the GUI
    // agent kept running).
    this.handleDeterministicControl(text);
    if (bareStop) {
      // A bare stop should end playback, not trigger "好的，已暂停…" audio.
      this.markUserStop();
      this.provider.cancelResponse();
    }

    this.resetAwakeTimer();
    this.notifyState();
    return Boolean(bareStop);
  }

  private handleTaskStatusQuery(text: string): boolean {
    if (!this.isTaskStatusQuery(text)) {
      return false;
    }
    const coding = this.options.codingAgent?.getStatus();
    const codingIsRecent =
      coding &&
      coding.status !== 'idle' &&
      (coding.status === 'running' ||
        Date.now() - (coding.endedAt ?? 0) < 120_000);
    // The model may already be answering the audio input. A deterministic
    // status reply owns this turn; cancel the in-flight reply so it cannot
    // race with a duplicate create_text_file / GUI tool call.
    this.provider.cancelResponse();
    if (coding && codingIsRecent) {
      if (coding.status === 'running') {
        this.speak(
          `编码任务正在执行，最后状态：${coding.lastMessage || '处理中'}。`,
        );
      } else if (coding.status === 'done') {
        const summary = this.summarizeCodingResult(coding.result);
        this.speak(
          summary ? `编码任务已完成。总结：${summary}` : '编码任务已完成。',
        );
      } else if (coding.status === 'failed') {
        this.speak(`编码任务失败：${coding.error || '未知错误'}`);
      } else {
        this.speak('编码任务已取消。');
      }
      return true;
    }
    this.speak(this.taskConversation.describeStatus());
    return true;
  }

  private handleCodingCommand(text: string): boolean {
    const codingAgent = this.options.codingAgent;
    if (!codingAgent) {
      return false;
    }

    const hasCodeFile =
      /\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|cpp|c|go|rs|rb|php|sh|ps1)\b/i.test(
        text,
      );
    const hasCodeVerb =
      /(创建|新建|写|生成|实现|修复|改|重构|添加|加|运行|执行|跑|测试|test|run|execute)/i.test(
        text,
      );
    const hasRepoContext =
      /(项目|仓库|代码|工作区|workspace|demo|coding)/i.test(text);
    const hasStrongCodeTerm =
      /(代码|脚本|接口|函数|组件|bug|测试|运行|执行|仓库|workspace|coding|修复)/i.test(
        text,
      );
    if (
      !(hasCodeFile && hasCodeVerb) &&
      !(hasRepoContext && hasStrongCodeTerm)
    ) {
      return false;
    }

    if (this.controller.isBusy()) {
      this.speak('当前有一个 GUI 任务在运行，先完成后我再开始编码任务。');
      return true;
    }
    if (codingAgent.isBusy()) {
      this.speak('编码任务已经在运行了，请稍等。');
      return true;
    }

    this.provider.cancelResponse();
    this.resetAwakeTimer();
    this.codingToolGuardUntil = Date.now() + 180_000;
    this.lastCodingProgressAt = 0;
    this.lastCodingProgressMessage = '';
    this.codingFileNames = new Set(
      (
        text.match(
          /[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|cpp|c|go|rs|rb|php|sh|ps1)\b/gi,
        ) || []
      ).map((name) => path.basename(name).toLowerCase()),
    );
    void codingAgent
      .start(text)
      .then((task) => {
        if (task.status === 'running') {
          this.speak('好的，编码任务已启动，我会在完成后汇报结果。');
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(message),
        );
        this.speak(`编码任务启动失败：${message}`);
      });
    return true;
  }

  private isTaskStatusQuery(text: string): boolean {
    return /(?:任务.*(?:进度|状态|到哪|第几步)|(?:进度|第几步|执行到哪|做到哪|现在在做什么)|(?:任务|你).*怎么样了|(?:开始|做完|完成|执行完|跑完|弄完|创建完).{0,3}(?:了)?(?:吗|没|没有)|(?:还在|仍在).{0,4}(?:做|执行|运行|处理))/i.test(
      text,
    );
  }

  private tryRecoveredConfirmation(): boolean {
    const router = this.options.fastToolRouter;
    const lastCommand = this.lastActionableUserText.trim();
    if (!router || !lastCommand) {
      return false;
    }
    if (router.canHandle(lastCommand)) {
      this.fastToolGuardUntil = Date.now() + 8000;
      this.deterministicFastToolGuardUntil = Date.now() + 8000;
      this.provider.cancelResponse();
      void router
        .executeConfirmedCommand(lastCommand)
        .then((outcome) => {
          if (!outcome?.handled || !outcome.speech) {
            return;
          }
          this.conversationConfirmationUntil = 0;
          this.fastToolGuardUntil = Date.now() + 3000;
          this.deterministicFastToolGuardUntil = Date.now() + 3000;
          this.speak(outcome.speech);
        })
        .catch((error: unknown) => {
          this.fastToolGuardUntil = 0;
          this.deterministicFastToolGuardUntil = 0;
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.callbacks.onError?.(normalized);
          this.speak(`操作失败：${normalized.message}`);
        });
      return true;
    }
    if (
      !this.controller.isBusy() &&
      classifyIntent(lastCommand).kind === 'task'
    ) {
      try {
        this.conversationConfirmationUntil = 0;
        this.controller.startTask(lastCommand, 'voice');
        return true;
      } catch (error) {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return false;
  }

  private resolveSiteTarget(value: string, query?: string) {
    const site = resolveSite(value);
    if (!site) throw new Error('Unknown site: ' + value);
    return {
      label: site.label,
      url: query ? buildSiteSearchUrl(site, query) : site.url,
    };
  }

  private async executeNavigation(
    call: VoiceToolCallWithId,
    tool: string,
    args: Record<string, unknown>,
    fallback: () => Promise<void>,
  ): Promise<boolean> {
    const executions = this.navigationExecutions;
    const key = JSON.stringify([tool, args]);
    if (executions.has(key)) {
      this.provider.sendToolResult(
        call.callId,
        'ALREADY_HANDLED_BY_FAST_TOOL: this navigation was already requested in this turn.',
      );
      return false;
    }
    executions.add(key);
    try {
      const completed = await this.runNavigation(call, tool, args, fallback);
      if (!completed) executions.delete(key);
      return completed;
    } catch (error) {
      executions.delete(key);
      throw error;
    }
  }

  private async runNavigation(
    call: VoiceToolCallWithId,
    tool: string,
    args: Record<string, unknown>,
    fallback: () => Promise<void>,
  ): Promise<boolean> {
    const router = this.options.fastToolRouter;
    if (!router) {
      await fallback();
      return true;
    }
    if (router.hasPendingConfirmation()) {
      this.provider.cancelResponse();
      return false;
    }
    const execution = await router.executeNavigationTool(tool, args);
    const outcome = execution?.outcome;
    if (outcome?.result?.error?.code === 'CONFIRMATION_REQUIRED') {
      this.provider.cancelResponse();
      this.speak(outcome.speech || SENSITIVE_CONFIRMATION_PROMPT);
      return false;
    }
    if (!outcome?.ok) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'failed',
          error: outcome?.result?.error,
          message: outcome?.speech || 'Navigation tool unavailable',
        }),
      );
      return false;
    }
    return true;
  }

  private async finishFastOpen(
    call: VoiceToolCallWithId,
    target: string,
    taskInstruction: unknown,
    delayMs: number,
    silent = false,
  ): Promise<void> {
    const instruction =
      typeof taskInstruction === 'string' ? taskInstruction.trim() : '';
    if (!instruction || isExplicitChat(instruction)) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: true,
          status: 'opened',
          target,
          message: silent
            ? 'OPENED. The user asked to browse without a summary. Do NOT read, summarize, or describe results. Do not claim what is on the page; wait for the user.'
            : 'OPENED. The target is opening/loading. If the user asked you to read, compare, or click results, call start_gui_task with a concrete instruction. Do not claim results yet.',
        }),
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const task = this.controller.startTask(instruction, 'voice');
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: true,
          status: 'started',
          target,
          task_id: task.taskId,
          message:
            'TASK_STARTED. The GUI agent is working on the opened target. Do NOT claim completion; wait for task_done/task_failed.',
        }),
      );
    } catch (error) {
      if (error instanceof TaskBusyError) {
        this.provider.sendToolResult(
          call.callId,
          'TASK_BUSY: a GUI task is already running. Ask the user whether to cancel it before starting a new one.',
        );
        return;
      }
      this.provider.sendToolResult(
        call.callId,
        `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleToolCall(call: VoiceToolCallWithId): Promise<void> {
    if (!this.awake) {
      this.provider.sendToolResult(
        call.callId,
        'REJECTED: the assistant is asleep. Do not execute anything.',
      );
      return;
    }

    this.resetAwakeTimer();
    // A barge "停一下" often arrives just before the model's already-planned
    // open_site/start_gui_task call. Do not let that queued call start a new
    // task after the user asked to stop.
    if (
      Date.now() < this.stopToolGuardUntil &&
      !/^(?:get_|cancel_|pause_|stop_)/.test(call.name)
    ) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'stopped',
          message:
            'STOPPED: the user asked to stop. Do not start or continue any task or tool action.',
        }),
      );
      console.log('[cyrvis voice] tool call blocked by stop guard', {
        tool: call.name,
      });
      return;
    }
    const localFastTool = this.options.fastToolRouter?.resolveProviderToolName(
      call.name,
    );
    const effectiveTool =
      localFastTool === 'capability.invoke'
        ? String((call.args as Record<string, unknown>).toolId || '')
        : localFastTool;
    const navigationCall = [
      'search_web',
      'open_url',
      'open_app',
      'open_site',
    ].includes(call.name);
    // While the coding worker owns the workspace, the voice model must not
    // race it with a duplicate create_text_file / GUI launch. This was
    // observed when the user asked "你开始做了吗？" mid-task: the model wrote
    // 桌面/hello.js while the worker was already writing CYRVIS-demo/hello.js.
    const codingControlCall =
      call.name === 'get_coding_status' || call.name === 'cancel_coding_task';
    const requestedCodingFile =
      call.name === 'create_text_file'
        ? path.basename(String(call.args.path || '')).toLowerCase()
        : '';
    const duplicateCodingFile =
      Date.now() < this.codingToolGuardUntil &&
      Boolean(requestedCodingFile) &&
      this.codingFileNames.has(requestedCodingFile);
    if (
      (this.options.codingAgent?.isBusy() || duplicateCodingFile) &&
      !codingControlCall &&
      (localFastTool ||
        navigationCall ||
        call.name === 'create_text_file' ||
        call.name === 'start_gui_task' ||
        call.name === 'start_coding_task')
    ) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: duplicateCodingFile
            ? 'coding_file_already_handled'
            : 'coding_task_running',
          message: duplicateCodingFile
            ? 'CODING_FILE_ALREADY_HANDLED: the coding worker is creating this file. Do not create or overwrite it from the voice tool. Report the coding task status instead.'
            : 'CODING_TASK_RUNNING: the coding worker owns this workspace. Do not create files, run commands, or start another task. Tell the user it is still running; use get_coding_status for progress.',
        }),
      );
      return;
    }
    if (
      Date.now() < this.deterministicFastToolGuardUntil &&
      (localFastTool || navigationCall || call.name === 'start_gui_task')
    ) {
      this.provider.sendToolResult(
        call.callId,
        'ALREADY_HANDLED_BY_FAST_TOOL: the deterministic local route already handled this turn. Do not execute it again.',
      );
      return;
    }
    if (
      Date.now() >= this.deterministicFastToolGuardUntil &&
      ((effectiveTool && NAVIGATION_TOOL_ALIASES[effectiveTool]) ||
        navigationCall)
    ) {
      const mode = this.lastVoiceIntent?.mode;
      if (mode === 'answer') {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: 'answer_from_knowledge',
            message:
              `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge. ` +
              'Answer from your internal knowledge; do not use a web or app fast tool.',
          }),
        );
        return;
      }
      if (mode === 'search' && localFastTool) {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: 'use_search_tool',
            query: this.lastVoiceIntent?.query,
            message: `USE_SEARCH_WEB: call search_web with query "${this.lastVoiceIntent?.query}" instead of cyrvis web tools.`,
          }),
        );
        return;
      }
      if (mode === 'navigate' && localFastTool) {
        const target = this.lastVoiceIntent?.target;
        const isApp = this.lastVoiceIntent?.targetKind === 'app';
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: isApp ? 'use_open_app' : 'use_open_site',
            target,
            message: isApp
              ? `USE_OPEN_APP: call open_app with app "${target}" instead of a cyrvis app tool.`
              : `USE_OPEN_SITE: call open_site with site "${target ?? 'bing'}" instead of a cyrvis web tool.`,
          }),
        );
        return;
      }
    }
    if (localFastTool) {
      if (this.options.fastToolRouter?.hasPendingConfirmation()) {
        this.provider.cancelResponse();
        console.info('[cyrvis fast-tools] ignored tool call while confirming', {
          providerTool: call.name,
          tool: localFastTool,
        });
        return;
      }
      const canonical = effectiveTool && NAVIGATION_TOOL_ALIASES[effectiveTool];
      if (canonical) {
        const args =
          localFastTool === 'capability.invoke'
            ? (call.args as Record<string, unknown>).arguments
            : call.args;
        const input =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        await this.handleToolCall({
          ...call,
          name: canonical,
          args: {
            ...input,
            ...(canonical === 'open_app' ? { app: input.name } : {}),
          },
        } as VoiceToolCallWithId);
        return;
      }
      await this.handleFastProviderToolCall(call, localFastTool);
      return;
    }

    switch (call.name) {
      case 'start_gui_task': {
        if (this.options.codingAgent?.isBusy()) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'busy',
              message:
                'A coding task is already running. Cancel it before starting a GUI task.',
            }),
          );
          return;
        }
        // Semantic intents own the turn before the dynamic web.search shortcut.
        const earlyInstruction = call.args.instruction?.trim() || '';
        const earlyIntent = this.lastVoiceIntent;
        const earlyNeedsGui = GUI_INTERACTION_PATTERNS.some((pattern) =>
          pattern.test(earlyInstruction),
        );
        if (earlyIntent?.mode === 'navigate' && !earlyNeedsGui) {
          const target = earlyIntent.target;
          const isApp = earlyIntent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation, not a GUI task. Call open_app with app "${target}".`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation, not a GUI task. Call open_site with site "${target ?? 'bing'}".`,
            }),
          );
          return;
        }
        if (
          earlyIntent?.mode === 'search' &&
          earlyIntent.confidence === 'high' &&
          !earlyNeedsGui
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_search_tool',
              query: earlyIntent.query,
              message:
                `USE_SEARCH_WEB: "${this.lastUserText}" is a web information need, not a GUI automation task. ` +
                `Call search_web with query "${earlyIntent.query}" instead. ` +
                'If the user also wants to read/compare/click the results, pass a task_instruction to search_web.',
            }),
          );
          return;
        }
        if (earlyIntent?.mode === 'answer') {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'answer_from_knowledge',
              message:
                `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge. ` +
                'Answer from your internal knowledge; do not start a GUI task or search.',
            }),
          );
          return;
        }

        const searchQuery = extractBrowserSearchQuery(
          call.args.instruction || '',
        );
        if (searchQuery && this.options.fastToolRouter) {
          await this.handleToolCall({
            ...call,
            name: 'search_web',
            args: { query: searchQuery },
          });
          return;
        }
        if (Date.now() < this.fastToolGuardUntil) {
          this.provider.sendToolResult(
            call.callId,
            'ALREADY_HANDLED_BY_FAST_TOOL: the local fast-tool matrix handled the user command. Do not start a GUI task for the same request.',
          );
          return;
        }
        const instruction = call.args.instruction?.trim();
        if (!instruction) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: instruction is required.',
          );
          return;
        }

        const instructionDecision = classifyIntent(instruction);
        const userDecision = this.lastUserText
          ? classifyIntent(this.lastUserText)
          : null;
        const userIsExplicitChat = this.lastUserText
          ? isExplicitChat(this.lastUserText)
          : false;
        const travelText = `${this.lastUserText} ${instruction}`;
        if (
          isTravelPlanningText(travelText) &&
          !isExplicitTravelGuiRequest(travelText)
        ) {
          this.provider.sendToolResult(
            call.callId,
            'REJECTED: this is travel planning, not a desktop GUI task. Use travel_update_plan / travel_probe_highlights / travel_set_preference / travel_set_constraints / travel_expand_aspect / travel_finalize_plan instead. Only call start_gui_task when the user explicitly asks to open a booking site and operate it.',
          );
          return;
        }

        // The model often paraphrases the user's task with verbs the gate does
        // not know ("在桌面新建一个txt文件..." lacks 打开/搜索/给我). Allow the
        // call when either the instruction or the original user text is a task.
        const allowedByUserText = userDecision?.kind === 'task';
        if (
          (instructionDecision.kind !== 'task' && !allowedByUserText) ||
          userIsExplicitChat
        ) {
          this.provider.sendToolResult(
            call.callId,
            'REJECTED: this is conversation, not a GUI task. Do not call the GUI agent. Answer the user directly or ask a clarifying question.',
          );
          return;
        }

        // The model sometimes routes "我要去巴黎的机票" or "打开B站" to the
        // GUI agent and slowly clicks through a homepage. Pure navigation and
        // search have faster fast-path tools. Allow the GUI path when the
        // instruction itself needs interaction.
        const voiceIntent = this.lastVoiceIntent;
        const needsGuiInteraction = GUI_INTERACTION_PATTERNS.some((pattern) =>
          pattern.test(instruction),
        );
        if (voiceIntent?.mode === 'navigate' && !needsGuiInteraction) {
          const target = voiceIntent.target;
          const isApp = voiceIntent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation, not a GUI task. Call open_app with app "${target}".`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation, not a GUI task. Call open_site with site "${target ?? 'bing'}".`,
            }),
          );
          return;
        }
        if (
          voiceIntent?.mode === 'search' &&
          voiceIntent.confidence === 'high' &&
          !needsGuiInteraction
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_search_tool',
              query: voiceIntent.query,
              message:
                `USE_SEARCH_WEB: "${this.lastUserText}" is a web information need, not a GUI automation task. ` +
                `Call search_web with query "${voiceIntent.query}" instead. ` +
                'If the user also wants to read/compare/click the results, pass a task_instruction to search_web.',
            }),
          );
          return;
        }

        try {
          const task = this.controller.startTask(instruction, 'voice');
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              task_id: task.taskId,
              status: 'started',
              message:
                'TASK_STARTED. The GUI agent is still executing. Do NOT claim the task is complete. Say briefly that you are working on it, then wait for the final task_done/task_failed event.',
            }),
          );
        } catch (error) {
          if (error instanceof TaskBusyError) {
            this.provider.sendToolResult(
              call.callId,
              'TASK_BUSY: a GUI task is already running. Ask the user whether to cancel it before starting a new one.',
            );
            return;
          }
          throw error;
        }
        break;
      }
      case 'search_web': {
        const intent = this.lastVoiceIntent;
        if (intent?.mode === 'navigate') {
          const isApp = intent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target: intent.target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation. Call open_app with app "${intent.target}" instead of searching.`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation. Call open_site with site "${intent.target ?? 'bing'}" instead of searching.`,
            }),
          );
          return;
        }
        if (intent?.mode === 'answer') {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'answer_from_knowledge',
              message:
                `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge, not a live web lookup. ` +
                'Answer now from your internal knowledge. Do not search. If you are genuinely unsure, say so and ask the user for permission to search.',
            }),
          );
          return;
        }
        const query = String(call.args.query || '').trim();

        // "打开B站搜一下猫": keep the search inside Bilibili instead of
        // sending the user to a generic Bing results page.
        if (
          intent?.siteSearch &&
          intent.target &&
          intent.targetKind === 'site'
        ) {
          const siteQuery = query || intent.query;
          if (siteQuery) {
            try {
              const result = this.resolveSiteTarget(intent.target, siteQuery);
              if (
                !(await this.executeNavigation(
                  call,
                  'web.open_url',
                  { url: result.url },
                  async () => {
                    const { openUrl } = await import('./desktop-actions');
                    await openUrl(result.url);
                  },
                ))
              )
                return;
              await this.finishFastOpen(
                call,
                `${result.label}: ${result.url}`,
                call.args.task_instruction,
                1200,
                intent.silent,
              );
              break;
            } catch (error) {
              console.warn('[cyrvis voice] site search redirect failed', error);
            }
          }
        }

        if (!query) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: search_web requires a query.',
          );
          return;
        }
        const engineValue = String(call.args.engine || defaultSearchEngine());
        const engine: SearchEngine =
          engineValue === 'baidu' || engineValue === 'google'
            ? (engineValue as SearchEngine)
            : 'bing';
        const site =
          typeof call.args.site === 'string' ? call.args.site : undefined;
        try {
          const url = buildSearchUrl(query, engine, site);
          if (
            !(await this.executeNavigation(
              call,
              'web.search',
              { query, engine, site },
              async () => {
                const { openSearch } = await import('./desktop-actions');
                await openSearch(url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            url,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'open_url': {
        const url = String(call.args.url || '').trim();
        if (!url) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: open_url requires a URL.',
          );
          return;
        }
        try {
          const opened = url;
          if (
            !(await this.executeNavigation(
              call,
              'web.open_url',
              { url },
              async () => {
                const { openUrl } = await import('./desktop-actions');
                await openUrl(url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            opened,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'open_app': {
        if (
          this.lastVoiceIntent?.mode === 'navigate' &&
          this.lastVoiceIntent.targetKind === 'site' &&
          this.lastVoiceIntent.target
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_open_site',
              target: this.lastVoiceIntent.target,
              message: `USE_OPEN_SITE: "${this.lastUserText}" is site navigation. Call open_site with site "${this.lastVoiceIntent.target}" instead of opening an app.`,
            }),
          );
          return;
        }
        const appValue = String(call.args.app || '');
        const allowedApps: AllowedApp[] = [
          'vscode',
          'chrome',
          'explorer',
          'notepad',
        ];
        if (
          !this.options.fastToolRouter &&
          !allowedApps.includes(appValue as AllowedApp)
        ) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: unsupported app. Allowed: ${allowedApps.join(', ')}.`,
          );
          return;
        }
        const target =
          typeof call.args.target === 'string' ? call.args.target : undefined;
        try {
          if (
            !(await this.executeNavigation(
              call,
              'app.launch',
              { name: appValue, target },
              async () => {
                const { openApp } = await import('./desktop-actions');
                await openApp(appValue as AllowedApp, target);
              },
            ))
          )
            return;
          const label = target ? `${appValue}:${target}` : appValue;
          await this.finishFastOpen(
            call,
            label,
            call.args.task_instruction,
            1800,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'create_text_file': {
        const path = String(call.args.path || '').trim();
        const content =
          typeof call.args.content === 'string' ? call.args.content : '';
        const shouldOpen = call.args.open !== false;
        const overwrite = call.args.overwrite === true;
        if (!path) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: create_text_file requires a path.',
          );
          return;
        }
        if (!this.options.fastToolRouter) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: fast file tools are unavailable.',
          );
          return;
        }
        try {
          if (
            !(await this.executeNavigation(
              call,
              'fs.create_file',
              { path, content, overwrite },
              async () => {
                throw new Error('fast file tools are unavailable');
              },
            ))
          ) {
            return;
          }

          let opened = false;
          if (shouldOpen) {
            const openResult =
              await this.options.fastToolRouter.executeNavigationTool(
                'fs.open',
                { path },
              );
            opened = openResult?.outcome?.ok === true;

            if (!opened) {
              const extension = path.split('.').pop()?.toLowerCase() || '';
              const textLike = [
                'txt',
                'md',
                'log',
                'json',
                'csv',
                'yaml',
                'yml',
                'ini',
                'xml',
                'html',
                'css',
                'js',
                'ts',
                'tsx',
                'jsx',
                'py',
              ].includes(extension);
              if (textLike) {
                // Last-resort visible launch for text documents when the
                // shell association cannot open the file.
                const { openApp } = await import('./desktop-actions');
                await openApp('notepad', path);
                opened = true;
              }
            }
          }

          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: opened ? 'created_and_opened' : 'created',
              path,
              bytes: Buffer.byteLength(content, 'utf8'),
              message: opened
                ? 'FILE_CREATED_AND_OPENED. Do not claim anything beyond what the tool returned; wait for the user.'
                : 'FILE_CREATED. The file was written but not opened.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'start_coding_task': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        if (this.controller.isBusy()) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'busy',
              message:
                'A GUI task is already running. Finish or cancel it before starting a coding task.',
            }),
          );
          return;
        }
        const instruction = String(call.args.instruction || '').trim();
        if (!instruction) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: start_coding_task requires an instruction.',
          );
          return;
        }
        const requestedWorkspace = String(call.args.workspace || '').trim();
        if (
          requestedWorkspace &&
          path.resolve(requestedWorkspace) !==
            this.options.codingAgent.getWorkspace()
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'workspace_rejected',
              message: `Coding workspace is fixed to ${this.options.codingAgent.getWorkspace()}.`,
            }),
          );
          return;
        }
        try {
          const task = await this.options.codingAgent.start(instruction);
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: task.status,
              task_id: task.taskId,
              workspace: task.workspace,
              message:
                'CODING_TASK_STARTED. Do not claim completion; use get_coding_status or wait for the final result.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'get_coding_status': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(this.options.codingAgent.getStatus()),
        );
        break;
      }
      case 'cancel_coding_task': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        const task = await this.options.codingAgent.cancel();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'open_site': {
        if (
          this.lastVoiceIntent?.targetKind === 'app' &&
          this.lastVoiceIntent.target
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_open_app',
              target: this.lastVoiceIntent.target,
              message: `USE_OPEN_APP: "${this.lastUserText}" is app navigation. Call open_app with app "${this.lastVoiceIntent.target}" instead of open_site.`,
            }),
          );
          return;
        }
        const siteValue = String(call.args.site || '').trim();
        if (!siteValue) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: open_site requires a site.',
          );
          return;
        }
        const query =
          typeof call.args.query === 'string' ? call.args.query.trim() : '';
        try {
          const result = this.resolveSiteTarget(siteValue, query || undefined);
          if (
            !(await this.executeNavigation(
              call,
              'web.open_url',
              { url: result.url },
              async () => {
                const { openUrl } = await import('./desktop-actions');
                await openUrl(result.url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            `${result.label}: ${result.url}`,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'cancel_gui_task': {
        if (
          this.lastDeterministicControl?.kind === 'cancel' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
        const task = await this.controller.cancelTask(call.args.task_id);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'pause_gui_task': {
        if (
          this.lastDeterministicControl?.kind === 'pause' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
        const task = await this.controller.pauseTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'resume_gui_task': {
        const task = await this.controller.resumeTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'get_gui_status': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(this.controller.getStatus()),
        );
        break;
      }
      case 'remember_fact': {
        const text = call.args.text?.trim();
        if (!text || !this.options.rememberFact) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: long-term memory is unavailable or the fact is empty.',
          );
          break;
        }
        try {
          await this.options.rememberFact(text);
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({ ok: true, remembered: text }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'travel_update_plan': {
        const snapshot = travelPlanner.updateFramework({
          destination: call.args.destination,
          origin: call.args.origin,
          startDate: call.args.start_date,
          endDate: call.args.end_date,
          companions: call.args.companions,
          budget: call.args.budget,
          purpose: call.args.purpose,
          transport: call.args.transport,
          userText: call.args.user_text || this.lastUserText,
        });
        if (snapshot.skeleton) {
          void appendTravelMemo('framework', '旅行基础框架', snapshot.skeleton);
        }
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message: /travel_expand_aspect|tickets|订票|雪票/.test(
                snapshot.speakHint || '',
              )
                ? 'Call travel_expand_aspect(aspect=tickets, with_search=false). Speak briefly; no GUI.'
                : snapshot.phase === 'probing_preferences'
                  ? 'Speak skeleton in one short line, then travel_probe_highlights.'
                  : 'Speak speakHint briefly; ask at most one missing field.',
            }),
          ),
        );
        break;
      }
      case 'travel_get_plan': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(slimTravelResult(travelPlanner.getSnapshot())),
        );
        break;
      }
      case 'travel_confirm_skeleton': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(travelPlanner.confirmSkeleton(), {
              message:
                'If preference missing, travel_probe_highlights next. Speak short.',
            }),
          ),
        );
        break;
      }
      case 'travel_probe_highlights': {
        const plan = travelPlanner.getSnapshot();
        if (plan.missingFramework.length > 0) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify(
              slimTravelResult(plan, {
                ok: false,
                message: 'Finish required framework fields first.',
              }),
            ),
          );
          break;
        }
        const probed = await probeTravelHighlights(plan.framework);
        if (probed.queries[0]) travelPlanner.noteSearch(probed.queries[0]);
        const snapshot = travelPlanner.setHighlights(probed.highlights);
        void appendTravelMemo(
          'highlights',
          `亮点试探-${plan.framework.destination || '旅行'}`,
          `${probed.season.monthLabel || ''} ${probed.season.festivalHints.join('、')}；` +
            snapshot.highlights
              .map((item) => `${item.interest}:${item.title}`)
              .join('；'),
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              highlights: snapshot.highlights.map((item) => ({
                interest: item.interest,
                title: item.title,
              })),
              message:
                'Ask which one category they prefer. One short question; no long lists.',
            }),
          ),
        );
        break;
      }
      case 'travel_set_preference': {
        const interest = call.args.interest?.trim();
        if (!interest) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: interest is required.',
          );
          break;
        }
        const snapshot = travelPlanner.setPreference(interest, call.args.notes);
        void appendTravelMemo(
          'preference',
          '旅行偏好',
          snapshot.interestLabel || interest,
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message:
                'Acknowledge preference in one short line, then ask constraint card.',
            }),
          ),
        );
        break;
      }
      case 'travel_set_constraints': {
        const snapshot = travelPlanner.setConstraints({
          okWithWalking: call.args.ok_with_walking,
          okWithEarlyStart: call.args.ok_with_early_start,
          okWithQueues: call.args.ok_with_queues,
          notes: call.args.notes,
          userText: call.args.user_text || this.lastUserText,
        });
        void appendTravelMemo(
          'constraints',
          '旅行约束卡片',
          JSON.stringify(snapshot.constraints),
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message:
                'Confirm constraints briefly, then offer one next aspect.',
            }),
          ),
        );
        break;
      }
      case 'travel_expand_aspect': {
        const aspect = call.args.aspect?.trim();
        if (!aspect) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: aspect is required.',
          );
          break;
        }
        let snippets: string[] = [];
        const bookableLike =
          /ticket|accommodation|门票|票务|买票|订票|预约|预订|雪票|住宿|酒店|民宿|ski/i.test(
            aspect,
          ) ||
          /(门票|买票|订票|预约|预订|雪票|展览票|演出票|乐园|住宿|酒店|民宿|住哪|帮我订)/.test(
            this.lastUserText || '',
          );
        // Tickets + hotels: catalog/generic links only — never GUI booking loops.
        const shouldSearch =
          call.args.with_search === true ||
          (call.args.with_search !== false && !bookableLike);
        if (shouldSearch) {
          const plan = travelPlanner.getSnapshot();
          const query = buildTravelSearchQuery(
            plan.framework,
            null,
            `${aspect} ${call.args.notes || ''}`.trim(),
          );
          travelPlanner.noteSearch(query);
          const search = await searchTravelInfo(query);
          snippets = hitsToSnippets(search.hits);
        }
        travelPlanner.syncFromConversation([
          this.lastUserText,
          aspect,
          call.args.notes || '',
        ]);
        const snapshot = travelPlanner.expandAspect(
          aspect,
          call.args.notes,
          snippets,
          this.lastUserText,
        );
        const latest = snapshot.aspects[snapshot.aspects.length - 1];
        if (latest) {
          void appendTravelMemo('aspect', latest.aspect, latest.summary);
        }
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              latestAspect: latest
                ? { aspect: latest.aspect, summary: latest.summary }
                : null,
              message: bookableLike
                ? 'Speak 2-3 option names briefly; say links are in the notes. No GUI. Soft-bridge once.'
                : 'Speak Day plan / options briefly from speakHint. Do not re-ask preference.',
            }),
          ),
        );
        break;
      }
      case 'travel_search': {
        const plan = travelPlanner.getSnapshot();
        const query =
          call.args.query?.trim() ||
          buildTravelSearchQuery(
            plan.framework,
            null,
            call.args.aspect || this.lastUserText,
          );
        travelPlanner.noteSearch(query);
        // Keep planner warm even when search is the first travel tool call.
        if (plan.phase === 'idle' && this.lastUserText) {
          travelPlanner.updateFramework({ userText: this.lastUserText });
        }
        const search = await searchTravelInfo(query);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: search.ok,
            query: search.query,
            hits: search.hits.slice(0, 3),
            error: search.error,
            phase: travelPlanner.getSnapshot().phase,
            message:
              'Use hits as short hints only. Do not invent live prices. Speak briefly.',
          }),
        );
        break;
      }
      case 'travel_decline_expand': {
        const snapshot = travelPlanner.declineFurther();
        void appendTravelMemo(
          'pause',
          '旅行规划先告一段落',
          snapshot.skeleton || snapshot.speakHint,
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message:
                'Soft close in one sentence. Offer travel_finalize_plan if they want the desktop txt.',
            }),
          ),
        );
        break;
      }
      case 'travel_finalize_plan': {
        try {
          const plan = travelPlanner.getSnapshot();
          const written = await writeTravelPlanDesktopTxt(plan);
          const snapshot = travelPlanner.markFinalized(written.desktopPath);
          const fileName =
            written.desktopPath.split(/[/\\]/).pop() || written.desktopPath;
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              phase: snapshot.phase,
              desktopPath: written.desktopPath,
              fileName,
              speakHint: snapshot.speakHint,
              message:
                'ONLY say: the styled travel plan page is ready on the desktop; open it in the browser to review. One or two short sentences. Do NOT read any plan content aloud.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: failed to write travel plan txt: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        break;
      }
      case 'confirm_action': {
        this.provider.sendToolResult(
          call.callId,
          'ERROR: confirmation is not implemented yet.',
        );
        break;
      }
      default: {
        const unknown = call as { callId: string; name: string };
        this.provider.sendToolResult(
          unknown.callId,
          `ERROR: unknown tool "${unknown.name}".`,
        );
      }
    }
  }

  private handleFastToolCommand(text: string): boolean {
    const router = this.options.fastToolRouter;
    if (!router) {
      return false;
    }
    const startedAt = Date.now();
    this.fastToolGuardUntil = Date.now() + 8000;
    this.deterministicFastToolGuardUntil = Date.now() + 8000;
    this.provider.cancelResponse();
    this.resetAwakeTimer();
    void router
      .match(text)
      .then(async (route) => {
        if (!route) {
          return null;
        }
        console.info('[cyrvis fast-tools] route', {
          kind: route.kind,
          tool: route.tool,
          domain: route.domain,
          risk: route.risk,
          requiresConfirmation: route.requiresConfirmation,
        });
        return router.execute(route);
      })
      .then((outcome) => {
        if (!outcome?.handled || !outcome.speech) {
          return;
        }
        if (
          outcome.route?.kind === 'confirm' ||
          outcome.route?.kind === 'cancel'
        ) {
          this.conversationConfirmationUntil = 0;
        }
        console.info('[cyrvis fast-tools] result', {
          kind: outcome.route?.kind,
          tool: outcome.route?.tool,
          ok: outcome.ok,
          confirmationRequired: outcome.route?.requiresConfirmation === true,
          durationMs: Date.now() - startedAt,
        });
        this.fastToolGuardUntil = Date.now() + 3000;
        this.deterministicFastToolGuardUntil = Date.now() + 3000;
        this.speak(outcome.speech);
      })
      .catch((error: unknown) => {
        this.fastToolGuardUntil = 0;
        this.deterministicFastToolGuardUntil = 0;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(normalized);
        this.speak(`操作失败：${normalized.message}`);
      });
    return true;
  }

  private handleSemanticPendingReply(
    text: string,
    pending: NonNullable<ReturnType<FastToolRouter['getPendingConfirmation']>>,
  ): void {
    const router = this.options.fastToolRouter;
    const classify = this.options.classifyPendingIntent;
    if (!router || !classify) {
      return;
    }
    this.fastToolGuardUntil = Date.now() + 8_000;
    this.deterministicFastToolGuardUntil = Date.now() + 8_000;
    this.provider.cancelResponse();
    const context = [
      this.lastActionableUserText,
      this.taskConversation.describeStatus(),
    ]
      .filter(Boolean)
      .join('\n');
    void classify({ text, pending, context })
      .then(async (decision) => {
        const threshold = pending.risk === 'high' ? 0.9 : 0.82;
        if (decision.intent === 'confirm' && decision.confidence >= threshold) {
          const outcome = await router.confirmPending();
          this.markUserResponseOutput();
          this.speak(outcome.speech || '操作已执行。');
          console.info('[cyrvis intent-arbiter] confirmed', {
            tool: pending.tool,
            confidence: decision.confidence,
            reason: decision.reason,
          });
          return;
        }
        if (decision.intent === 'cancel' && decision.confidence >= 0.82) {
          const outcome = await router.cancelPending();
          this.markUserResponseOutput();
          this.speak(outcome.speech || '已取消。');
          console.info('[cyrvis intent-arbiter] cancelled', {
            tool: pending.tool,
            confidence: decision.confidence,
            reason: decision.reason,
          });
          return;
        }
        this.markUserResponseOutput();
        this.speak('待确认操作尚未执行。请明确说“执行”或“取消”。');
        console.info('[cyrvis intent-arbiter] ambiguous pending reply', {
          tool: pending.tool,
          intent: decision.intent,
          confidence: decision.confidence,
          reason: decision.reason,
        });
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(normalized);
        this.markUserResponseOutput();
        this.speak('没有判断出是否确认。请说“执行”或“取消”。');
      })
      .finally(() => {
        this.fastToolGuardUntil = Date.now() + 3_000;
        this.deterministicFastToolGuardUntil = Date.now() + 3_000;
        this.notifyState();
      });
  }

  private async handleFastProviderToolCall(
    call: VoiceToolCallWithId,
    localName: string,
  ): Promise<void> {
    const router = this.options.fastToolRouter;
    if (!router) {
      this.provider.sendToolResult(
        call.callId,
        'ERROR: local fast-tool router is unavailable.',
      );
      return;
    }

    const discoveryOnly =
      localName === 'capability.search' || localName === 'capability.describe';
    this.fastToolGuardUntil = discoveryOnly ? 0 : Date.now() + 8000;
    try {
      const execution = await router.executeProviderToolCall(
        call.name,
        call.args as Record<string, unknown>,
      );
      if (!execution) {
        this.provider.sendToolResult(
          call.callId,
          `ERROR: unknown local fast tool "${call.name}".`,
        );
        return;
      }
      const outcome = execution.outcome;
      const confirmationRequired =
        outcome.route?.requiresConfirmation === true ||
        outcome.result?.error?.code === 'CONFIRMATION_REQUIRED';
      if (confirmationRequired) {
        // Returning another tool result starts a new model response, which
        // commonly calls the same tool again and repeats "confirm". Cancel the
        // model turn and ask directly from the deterministic confirmation state.
        this.provider.cancelResponse();
        this.speak(outcome.speech || SENSITIVE_CONFIRMATION_PROMPT);
        console.info('[cyrvis fast-tools] confirmation required', {
          providerTool: call.name,
          tool: localName,
        });
        return;
      }
      const payload = {
        ok: outcome.ok === true,
        status: outcome.ok === true ? 'completed' : 'failed',
        tool: localName,
        message: outcome.speech,
        data: outcome.result?.data,
        error: outcome.result?.error,
      };
      const serialized = JSON.stringify(payload);
      this.provider.sendToolResult(
        call.callId,
        serialized.length > 12_000
          ? `${serialized.slice(0, 12_000)}...TRUNCATED`
          : serialized,
      );
      const handledLocally =
        !discoveryOnly &&
        (outcome.ok === true ||
          outcome.result?.error?.code === 'CONFIRMATION_REQUIRED');
      this.fastToolGuardUntil = handledLocally ? Date.now() + 3000 : 0;
      console.info('[cyrvis fast-tools] model tool result', {
        providerTool: call.name,
        tool: localName,
        ok: outcome.ok,
        confirmationRequired,
      });
    } catch (error) {
      this.fastToolGuardUntil = 0;
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[cyrvis fast-tools] model tool failed', {
        providerTool: call.name,
        tool: localName,
        error: message,
      });
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'failed',
          tool: localName,
          message: `本地工具执行失败：${message}`,
        }),
      );
    }
  }

  private handleContinueCommand(text: string): boolean {
    const isContinueOnly =
      /^(?:啊|呃|哦|嗯|好|ok)?[，,\s]*(?:继续|恢复|接着做|继续任务|continue|resume)(?:吧|啊|呀|刚刚那个任务|刚才那个任务|之前的任务)?[。！？!?，,\s]*$/i.test(
        text.trim(),
      );
    if (!isContinueOnly) {
      return false;
    }
    this.provider.cancelResponse();
    const status = this.controller.getStatus().status;
    if (status === 'paused') {
      void this.controller
        .resumeTask()
        .then(() => this.speak('继续执行。'))
        .catch((error: unknown) => {
          this.speak(
            `恢复任务失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return true;
    }
    if (status === 'starting' || status === 'executing') {
      this.speak('任务正在执行，不需要重复启动。');
      return true;
    }
    if (this.options.codingAgent?.isBusy()) {
      this.speak('编码任务正在执行，请稍等。');
      return true;
    }
    this.speak('当前没有可继续的任务，请重新说明要做什么。');
    return true;
  }

  private isStopFragment(text: string): boolean {
    return /^(?:停|停了|停下|停住|停止|停一下|下|住|止|别说了|不要说了|算了|取消)[。！？!?，,\s]*$/i.test(
      text.trim(),
    );
  }

  private isStopCommand(text: string): boolean {
    const compact = text
      .replace(/[，。！？、,.!?;；:：\s]/g, '')
      .replace(/^(?:呃|啊|哦|嗯|唉|诶)+/i, '');
    return /^(?:停|停一下|停一停|停下|停下来|停止|先停|别做|别做了|不要做|不要做了|取消|算了|stop|cancel|abort)(?:之前(?:的)?|目前|当前|这个|所有)?(?:任务|操作)?(?:吧|啊|呀|好吗|好不好)?$/i.test(
      compact,
    );
  }

  private handleStopCommand(): boolean {
    const status = this.controller.getStatus().status;
    const guiActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    const codingActive = this.options.codingAgent?.isBusy() === true;
    if (Date.now() - this.lastHardStopAt < 1_500) {
      return true;
    }
    this.lastHardStopAt = Date.now();
    this.pendingBargeStopAt = 0;
    this.provider.cancelResponse();
    this.markUserStop();
    this.taskConversation.markStopped();
    this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
    console.info('[cyrvis voice] hard stop', {
      gui: guiActive,
      coding: codingActive,
      speaking: this.ttsSpeaking,
    });
    if (guiActive) {
      void this.controller.cancelTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    if (codingActive) {
      void this.options.codingAgent?.cancel().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    return true;
  }

  private handleDeterministicControl(text: string): 'cancel' | 'pause' | null {
    const status = this.controller.getStatus().status;
    const guiActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    const codingActive = this.options.codingAgent?.isBusy() === true;
    if (!guiActive && !codingActive) {
      return null;
    }

    const explicitCancel =
      /(取消|算了|不想|不要|不用|停止|停下|停一下|先停|别做|别动|stop|cancel|abort)/i.test(
        text,
      ) || /(^|[\s，。])停([\s，。！？]|$)/.test(text);
    const pause = /(暂停|等一下|等等|pause)/i.test(text);

    if (explicitCancel) {
      this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
      if (guiActive) {
        void this.controller.cancelTask().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      if (codingActive) {
        void this.options.codingAgent?.cancel().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      return 'cancel';
    }
    if (pause) {
      this.lastDeterministicControl = { kind: 'pause', at: Date.now() };
      if (guiActive) {
        void this.controller.pauseTask().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      if (codingActive) {
        // The coding worker has no resumable pause; treat pause as a safe
        // cancellation instead of leaving it running.
        void this.options.codingAgent?.cancel().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      return 'pause';
    }
    return null;
  }

  private guardCompletionClaim(text: string): void {
    if (this.completionGuardTriggered) {
      return;
    }

    const status = this.controller.getStatus().status;
    const taskActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    if (!taskActive) {
      return;
    }

    this.assistantTextBuffer += text;
    if (!this.completionClaimPattern.test(this.assistantTextBuffer)) {
      return;
    }

    this.completionGuardTriggered = true;
    this.suppressAudioUntilResponseDone = true;
    this.provider.cancelResponse();
    this.callbacks.onAssistantText?.(
      '[任务仍在执行，已拦截提前完成声明]',
      true,
    );
    setTimeout(() => {
      this.speak('好的，我正在执行，请稍等。');
    }, 300);
  }

  private isSelfEchoTranscript(text: string): boolean {
    if (!this.lastAssistantText.trim()) {
      return false;
    }
    // Only close to recent assistant audio; this avoids treating an unrelated
    // "我在" much later as an echo.
    if (Date.now() - this.lastAssistantAudioAt > 3000) {
      return false;
    }
    const strip = (value: string) =>
      normalize(value).replace(/[，。！？,.!?\s]/g, '');
    const heard = strip(text);
    if (!heard) {
      return false;
    }
    const spoken = strip(this.lastAssistantText);
    if (spoken.includes(heard) || heard.includes(spoken)) {
      return true;
    }
    // ASR often truncates the assistant's short acknowledgement in speaker
    // mode. Keep this list deliberately narrow so a real "停" is unaffected.
    return /^(我在|我来|我|在听|我听到了|听到|嗯+|啊+|好+)$/.test(heard);
  }

  private isWakePhrase(text: string): boolean {
    const normalized = normalize(text);
    return this.wakePatterns.some((pattern) => pattern.test(normalized));
  }

  private wake(): void {
    if (this.awake) {
      this.resetAwakeTimer();
      return;
    }
    this.awake = true;
    this.callbacks.onWake?.();
    this.resetAwakeTimer();
    this.notifyState();
  }

  notifyCodingStatus(snapshot: CodingTaskSnapshot): void {
    if (snapshot.status === 'idle') {
      return;
    }
    if (snapshot.status === 'running') {
      this.notifyCodingProgress(snapshot);
      return;
    }
    console.info('[cyrvis coding] notify status', {
      status: snapshot.status,
      awake: this.awake,
      result: snapshot.result.slice(0, 200),
      error: snapshot.error,
    });
    if (!this.awake) {
      // A coding task can outlive the 20s wake window. Its completion is a
      // direct answer to the user's request, so wake and report it instead of
      // silently dropping the status.
      this.wake();
    }
    if (snapshot.status === 'done') {
      const summary = this.summarizeCodingResult(snapshot.result);
      this.speak(
        summary ? `编码任务完成。总结：${summary}` : '编码任务已完成。',
      );
    } else if (snapshot.status === 'failed') {
      this.speak(`编码任务失败：${snapshot.error || '未知错误'}`);
    } else if (snapshot.status === 'cancelled') {
      this.speak('编码任务已取消。');
    }
  }

  private notifyCodingProgress(snapshot: CodingTaskSnapshot): void {
    if (!this.awake || this.userSpeaking) {
      return;
    }
    const event = snapshot.lastEvent;
    if (!event?.tool) {
      return;
    }

    const isResult = event.ok !== undefined;
    let text = '';
    if (['write_file', 'edit_file', 'replace'].includes(event.tool)) {
      // Key node only: file finished writing, not the "reading/finding" noise.
      if (event.ok !== true) {
        return;
      }
      const file = path.basename(event.filePath || '') || '文件';
      text = `编码进度：已写入 ${file}`;
    } else if (event.tool === 'run_shell_command') {
      if (!isResult) {
        const command = event.message
          .replace(/^正在运行命令：/, '')
          .trim()
          .slice(0, 90);
        text = `编码进度：正在运行 ${command}`;
      } else {
        const output = this.cleanCodingOutput(
          event.output || event.message.replace(/^命令(?:完成|失败)：/, ''),
        );
        text = event.ok
          ? `运行结果：${output || '命令执行完成'}`
          : `运行失败：${output || '未知错误'}`;
      }
    } else {
      return;
    }

    const now = Date.now();
    if (!isResult && now - this.lastCodingProgressAt < 1_500) {
      return;
    }
    if (text === this.lastCodingProgressMessage) {
      return;
    }
    this.lastCodingProgressAt = now;
    this.lastCodingProgressMessage = text;
    console.info('[cyrvis coding] speak progress', { text });
    this.speak(text);
  }

  private cleanCodingOutput(value: string): string {
    return value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[|]{1,}/g, ' ')
      .replace(/-{3,}/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  private summarizeCodingResult(result: string): string {
    // Keep the contents of fenced blocks here: they often contain the command
    // output the user explicitly asked to hear. Only strip the fence markers.
    const normalized = result
      .replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, ' $1 ')
      .replace(/[|]{1,}/g, ' ')
      .replace(/-{3,}/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const runIndex = normalized.search(/(?:运行结果|执行结果|输出|exit code)/i);
    if (runIndex >= 0) {
      const before = normalized.slice(0, runIndex).slice(0, 90);
      const after = normalized.slice(runIndex).slice(0, 150);
      return `${before} ${after}`.trim();
    }
    return normalized.slice(0, 180);
  }

  private speak(text: string): void {
    this.taskConversation.noteAssistantOutput();
    this.markUserResponseOutput();
    this.ttsSpeaking = true;
    this.proactivity.setTtsSpeaking(true);
    this.provider.speak(text);
    this.notifyState();

    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
    }
    this.speakWatchdog = setTimeout(() => {
      this.ttsSpeaking = false;
      this.proactivity.setTtsSpeaking(false);
      this.notifyState();
    }, 15_000);
  }

  private armPlaybackWatchdog(): void {
    this.clearPlaybackWatchdog();
    this.playbackWatchdog = setTimeout(() => {
      this.playbackWatchdog = null;
      console.warn('[cyrvis voice] playback idle watchdog fired');
      this.ttsSpeaking = false;
      this.proactivity.setTtsSpeaking(false);
      this.notifyState();
    }, 15_000);
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog) {
      clearTimeout(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
  }

  private resetAwakeTimer(): void {
    this.clearAwakeTimer();
    if (!this.awake || this.awakeTimeoutMs <= 0) {
      return;
    }
    this.awakeTimer = setTimeout(() => {
      this.sleep();
    }, this.awakeTimeoutMs);
  }

  private clearAwakeTimer(): void {
    if (this.awakeTimer) {
      clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }
  }

  private notifyState(): void {
    this.callbacks.onState?.(this.getState());
  }
}
