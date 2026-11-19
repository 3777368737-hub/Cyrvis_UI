/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CyrvisController } from './controller';
import { TaskBusyError } from './controller';
import type { AllowedApp, SearchEngine } from './desktop-actions';
import { buildSearchUrl, defaultSearchEngine } from './navigation';
import { resolveSite, buildSiteSearchUrl } from './site-registry';
import { NAVIGATION_TOOL_ALIASES } from './voice/tool-surface';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import { classifyVoiceIntent, type VoiceIntentDecision } from './search-intent';
import { TaskConversationCoordinator } from './task-conversation';
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

export type VoiceBrainState = CyrvisVoiceState;

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
  inspectGaze?: (question: string) => Promise<string>;
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
  private lastUserText = '';
  private lastVoiceIntent: VoiceIntentDecision | null = null;
  private lastActionableUserText = '';
  private conversationConfirmationUntil = 0;
  private partialUserText = '';
  private assistantTextBuffer = '';
  private lastFinalTranscript = '';
  private lastFinalAt = 0;
  private inspectionGeneration = 0;
  private speechAwaitingTranscript = false;
  private speechTurn = 0;
  private pendingGazeRequests = 0;
  private gazeToolTurn: {
    generation: number;
    speechTurn: number;
    awaitingTranscript: boolean;
  } | null = null;
  private lastInspection: {
    question: string;
    at: number;
    result: Promise<string>;
  } | null = null;
  private deterministicInspection: {
    generation: number;
    toolReply: boolean;
    answered: boolean;
  } | null = null;
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
  private lastDeterministicControl: {
    kind: 'cancel' | 'pause';
    at: number;
  } | null = null;
  private fastToolGuardUntil = 0;
  private deterministicFastToolGuardUntil = 0;
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
        this.speak(text);
      },
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

  /** A button/hotkey is an explicit reply request even when voice is asleep. */
  speakRequestedReply(text: string): void {
    this.suppressReplyUntil = 0;
    this.wake();
    this.speak(text);
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
    this.clearUserResponseWatchdog();
    this.waitingForUserResponse = false;
  }

  /**
   * Deterministic barge stop. Do not wait for ASR: a confirmed barge may be a
   * short "停" that the model hears as empty or something else several seconds
   * later. Pause the GUI task and keep the assistant silent.
   */
  handleBargeStop(): void {
    this.markUserStop();
    const status = this.controller.getStatus().status;
    if (['starting', 'executing', 'paused'].includes(status)) {
      void this.controller.pauseTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
  }

  sleep(): void {
    this.inspectionGeneration++;
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
    this.inspectionGeneration++;
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
        if (!this.userSpeaking) {
          this.speechTurn++;
          this.speechAwaitingTranscript = true;
        }
        this.userSpeaking = true;
        this.ttsSpeaking = false;
        this.clearPlaybackWatchdog();
        this.proactivity.setUserSpeaking(true);
        this.proactivity.setTtsSpeaking(false);
        this.callbacks.onSpeechStarted?.();
        this.notifyState();
      },
      onSpeechStopped: () => {
        this.userSpeaking = false;
        this.proactivity.setUserSpeaking(false);
        this.callbacks.onSpeechStopped?.();
        this.notifyState();
      },
      onTranscript: (text, final) => this.handleTranscript(text, final),
      onAssistantText: (text, final) => {
        if (!this.awake || this.shouldSuppressReply()) {
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
        if (this.awake && !this.shouldSuppressReply()) {
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
          this.awake &&
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
    if (final && !text.trim()) {
      // Buffer clear/trim acknowledgements can arrive while an earlier tool
      // result is being spoken. Silence is not an explicit user stop.
      return true;
    }
    this.callbacks.onTranscript?.(text, final);

    if (!final) {
      this.partialUserText += text;
      if (!this.awake && this.isWakePhrase(this.partialUserText)) {
        this.wake();
      }
      return false;
    }

    this.partialUserText = '';

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
    // Realtime tools can precede the final ASR event for the same speech.
    // Keep that turn's generation instead of invalidating its pending result.
    const joinsEarlyGazeTool =
      this.speechAwaitingTranscript &&
      this.gazeToolTurn?.awaitingTranscript &&
      this.gazeToolTurn.speechTurn === this.speechTurn;
    if (joinsEarlyGazeTool) this.gazeToolTurn!.awaitingTranscript = false;
    else this.inspectionGeneration++;
    this.speechAwaitingTranscript = false;
    const inspectionGeneration = this.inspectionGeneration;
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

    if (this.gazeToolTurn?.generation === inspectionGeneration) {
      this.markUserResponseOutput();
      this.resetAwakeTimer();
      this.notifyState();
      return true;
    }

    if (!bareStop) {
      this.armUserResponseWatchdog();
    }

    // Consume gaze questions before fast tools. Cascade must skip its own
    // LLM turn when this handler returns true.
    if (
      this.options.inspectGaze &&
      /(我(?:现在在|正在|在)看什么|我看(?:的|着的)(?:是)?什么|看看我在看|这个是什么|帮我看看这里)/.test(
        text,
      )
    ) {
      this.provider.cancelResponse();
      this.markUserResponseOutput();
      const request = {
        generation: inspectionGeneration,
        toolReply: false,
        answered: false,
      };
      this.deterministicInspection = request;
      void this.inspectGaze(text).then(
        (answer) => {
          if (
            this.awake &&
            inspectionGeneration === this.inspectionGeneration &&
            !request.toolReply
          ) {
            request.answered = true;
            this.speak(answer);
          }
        },
        (error) => {
          if (
            this.awake &&
            inspectionGeneration === this.inspectionGeneration &&
            !request.toolReply
          ) {
            request.answered = true;
            this.speak(
              error instanceof Error ? error.message : '看屏识别失败，请重试。',
            );
          }
        },
      );
      this.resetAwakeTimer();
      this.notifyState();
      return true;
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
    this.speak(this.taskConversation.describeStatus());
    return true;
  }

  private isTaskStatusQuery(text: string): boolean {
    return /(?:任务.*(?:进度|状态|到哪|第几步)|(?:进度|第几步|执行到哪|做到哪|现在在做什么)|(?:任务|你).*怎么样了)/i.test(
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
      case 'inspect_gaze_target': {
        const generation = this.inspectionGeneration;
        const deterministic =
          this.deterministicInspection?.generation === generation
            ? this.deterministicInspection
            : null;
        // Join an in-flight local request, instead of taking a second screenshot.
        // Once spoken, cancel a late duplicate response so the mic is not left muted.
        if (deterministic?.answered || deterministic?.toolReply) {
          this.provider.cancelResponse();
          return;
        }
        if (deterministic) deterministic.toolReply = true;
        const turn = {
          generation,
          speechTurn: this.speechTurn,
          awaitingTranscript: this.speechAwaitingTranscript,
        };
        this.gazeToolTurn = turn;
        this.markUserResponseOutput();
        try {
          const answer = await (deterministic && this.lastInspection
            ? this.lastInspection.result
            : this.inspectGaze(
                call.args.question || this.lastUserText || '我在看什么？',
              ));
          if (this.awake && generation === this.inspectionGeneration)
            this.provider.sendToolResult(
              call.callId,
              JSON.stringify({ ok: true, answer, read_only: true }),
            );
        } catch (error) {
          if (this.awake && generation === this.inspectionGeneration)
            this.provider.sendToolResult(
              call.callId,
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : '看屏识别失败',
              }),
            );
        } finally {
          if (this.gazeToolTurn === turn) this.gazeToolTurn = null;
          this.resetAwakeTimer();
        }
        break;
      }
      case 'start_gui_task': {
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

  private inspectGaze(question: string): Promise<string> {
    if (!this.options.inspectGaze)
      return Promise.reject(new Error('当前未配置AI看屏功能。'));
    this.pendingGazeRequests++;
    let operation: Promise<string>;
    try {
      operation = this.options.inspectGaze(question);
    } catch (error) {
      operation = Promise.reject(error);
    }
    const result = operation.finally(() => {
      this.pendingGazeRequests--;
      this.resetAwakeTimer();
    });
    this.lastInspection = { question, at: Date.now(), result };
    return result;
  }

  private handleDeterministicControl(text: string): 'cancel' | 'pause' | null {
    const status = this.controller.getStatus().status;
    const active = ['starting', 'executing', 'paused', 'cancelling'].includes(
      status,
    );
    if (!active) {
      return null;
    }

    const explicitCancel =
      /(取消|算了|不想|不要|不用|停止|停下|别动|stop|cancel)/i.test(text) ||
      /(^|[\s，。])停([\s，。！？]|$)/.test(text);
    const pause = /(暂停|等一下|等等|pause)/i.test(text);

    if (explicitCancel) {
      this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
      void this.controller.cancelTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return 'cancel';
    }
    if (pause) {
      this.lastDeterministicControl = { kind: 'pause', at: Date.now() };
      void this.controller.pauseTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
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

  private speak(text: string): void {
    if (!this.awake) return;
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
      if (
        this.pendingGazeRequests > 0 ||
        this.ttsSpeaking ||
        this.controller.isBusy()
      ) {
        this.resetAwakeTimer();
        return;
      }
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
