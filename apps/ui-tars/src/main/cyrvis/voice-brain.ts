/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CyrvisController } from './controller';
import { TaskBusyError } from './controller';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import { TaskConversationCoordinator } from './task-conversation';
import type { ControllerEvent } from './types';
import {
  SENSITIVE_CONFIRMATION_PROMPT,
  extractBrowserSearchQuery,
  toFastToolProviderName,
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
  private lastDeterministicControl: {
    kind: 'cancel' | 'pause';
    at: number;
  } | null = null;
  private fastToolGuardUntil = 0;
  private deterministicFastToolGuardUntil = 0;
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
      if (!this.awake && this.isWakePhrase(this.partialUserText)) {
        this.wake();
      }
      return false;
    }

    this.partialUserText = '';

    if (!text.trim()) {
      // Qwen sometimes commits silence/noise and still generates a reply.
      // Treat it like a stop for a short window; an unrecognized "停" often
      // arrives here as an empty transcript and must not produce "好的，请问…".
      this.markUserStop();
      this.provider.cancelResponse();
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

    const canHandleFastTool =
      this.options.fastToolRouter?.canHandle(text) === true;
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
    if (!canHandleFastTool) {
      this.deterministicFastToolGuardUntil = 0;
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
          canHandleFastTool);
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
    if (
      Date.now() < this.deterministicFastToolGuardUntil &&
      (localFastTool || call.name === 'start_gui_task')
    ) {
      this.provider.sendToolResult(
        call.callId,
        'ALREADY_HANDLED_BY_FAST_TOOL: the deterministic local route already handled this turn. Do not execute it again.',
      );
      return;
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
      await this.handleFastProviderToolCall(call, localFastTool);
      return;
    }

    switch (call.name) {
      case 'start_gui_task': {
        const searchQuery = extractBrowserSearchQuery(
          call.args.instruction || '',
        );
        if (searchQuery && this.options.fastToolRouter) {
          await this.handleFastProviderToolCall(
            {
              ...call,
              name: toFastToolProviderName('web.search'),
              args: { query: searchQuery },
            },
            'web.search',
          );
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
