/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { BrowserWindow } from 'electron';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';
import {
  QWEN_ASR_DEFAULT_WS_URL,
  QWEN_ASR_MODEL,
  resolveVoiceSttProvider,
} from '@shared/voice';
import type {
  StreamingAsrAudioInput,
  StreamingAsrClaimInput,
  StreamingAsrEvent,
  StreamingAsrFinishResult,
  StreamingAsrStartInput,
} from '@shared/asrStream';

const ASR_SAMPLE_RATE = 16_000;
const START_TIMEOUT_MS = 15_000;
const FINISH_TIMEOUT_MS = 2_500;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;

type DashScopeAsrConfig = {
  url: string;
  apiKey: string;
  model: string;
  workspace?: string;
};

type DashScopeAsrMessage = {
  header?: {
    event?: string;
    task_id?: string;
    request_id?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      sentence?: {
        text?: string;
        heartbeat?: boolean;
        end_time?: number | null;
      };
    };
    usage?: unknown;
  };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type StreamingSession = {
  id: string;
  turnId?: string;
  taskId: string;
  socket: WebSocket;
  started: boolean;
  finishing: boolean;
  closed: boolean;
  requestId?: string;
  finalizedSentences: string[];
  currentSentence: string;
  startDeferred: Deferred<void>;
  finishDeferred: Deferred<StreamingAsrFinishResult> | null;
  timer: NodeJS.Timeout | null;
  createdAt: number;
  finishStartedAt?: number;
};

type StreamingAsrServiceOptions = {
  emit?: (event: StreamingAsrEvent) => void;
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
  getConfig?: () => DashScopeAsrConfig;
  finishTimeoutMs?: number;
};

type StreamingAsrEventPayload = StreamingAsrEvent extends infer TEvent
  ? TEvent extends StreamingAsrEvent
    ? Omit<TEvent, 'sessionId' | 'turnId'>
    : never
  : never;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const broadcastStreamingEvent = (event: StreamingAsrEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('voice:stream-event', event);
    }
  });
};

const normalizeWebSocketUrl = (baseUrl?: string) => {
  const raw = baseUrl?.trim() || QWEN_ASR_DEFAULT_WS_URL;
  const url = new URL(raw);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(
      'Qwen streaming ASR Base URL must use ws://, wss://, http://, or https://',
    );
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/api-ws/v1/inference';
  }
  return url.toString();
};

export class DashScopeStreamingAsrService {
  private readonly sessions = new Map<string, StreamingSession>();
  private preparePromise: Promise<string> | null = null;
  private preparedSessionId: string | null = null;
  private readonly emit: (event: StreamingAsrEvent) => void;
  private readonly createSocket: (
    url: string,
    options: ClientOptions,
  ) => WebSocket;
  private readonly getConfig: () => DashScopeAsrConfig;
  private readonly finishTimeoutMs: number;

  constructor(options: StreamingAsrServiceOptions = {}) {
    this.emit = options.emit || broadcastStreamingEvent;
    this.createSocket =
      options.createSocket ||
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.getConfig = options.getConfig || this.resolveConfig;
    this.finishTimeoutMs = options.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
  }

  private resolveConfig = (): DashScopeAsrConfig => {
    const settings = SettingStore.getStore();
    const provider = resolveVoiceSttProvider(
      settings.voiceSttProvider,
      settings.voiceSttModel,
    );
    if (provider !== 'qwen-dashscope-streaming') {
      throw new Error('Qwen streaming ASR is not the selected STT provider');
    }

    const apiKey =
      settings.voiceSttApiKey?.trim() ||
      env.voiceSttApiKey?.trim() ||
      env.conversationApiKey?.trim();
    if (!apiKey) {
      throw new Error('Qwen streaming ASR API Key is not configured');
    }

    return {
      url: normalizeWebSocketUrl(settings.voiceSttBaseUrl),
      apiKey,
      model: settings.voiceSttModel?.trim() || QWEN_ASR_MODEL,
      workspace: env.voiceSttWorkspace,
    };
  };

  private emitForSession(
    session: StreamingSession,
    event: StreamingAsrEventPayload,
  ) {
    this.emit({
      ...event,
      sessionId: session.id,
      turnId: session.turnId,
    } as StreamingAsrEvent);
  }

  private getFullText(session: StreamingSession) {
    return [...session.finalizedSentences, session.currentSentence]
      .filter(Boolean)
      .join('')
      .trim();
  }

  private completeWithAvailableText(
    session: StreamingSession,
    options: {
      fromPartial: boolean;
      error?: Error;
    },
  ) {
    const text = this.getFullText(session);
    if (!text && options.fromPartial) {
      if (options.error) {
        this.failSession(session, options.error);
      }
      return false;
    }

    const result: StreamingAsrFinishResult = {
      text,
      requestId: session.requestId,
      finalizedFromPartial: options.fromPartial,
    };
    session.finishDeferred?.resolve(result);
    this.emitForSession(session, {
      type: 'final',
      ...result,
    });
    logger.info('[QwenStreamingAsr] Finalized transcript', {
      sessionId: session.id,
      fromPartial: options.fromPartial,
      durationMs: session.finishStartedAt
        ? Date.now() - session.finishStartedAt
        : undefined,
      chars: text.length,
    });
    this.disposeSession(session);
    return true;
  }

  private clearTimer(session: StreamingSession) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  private failSession(session: StreamingSession, error: Error) {
    if (session.closed) {
      return;
    }
    logger.error('[QwenStreamingAsr]', error);
    session.startDeferred.reject(error);
    session.finishDeferred?.reject(error);
    this.emitForSession(session, {
      type: 'error',
      error: error.message,
    });
    this.disposeSession(session);
  }

  private disposeSession(session: StreamingSession) {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.clearTimer(session);
    this.sessions.delete(session.id);
    if (this.preparedSessionId === session.id) {
      this.preparedSessionId = null;
    }
    try {
      session.socket.close();
    } catch {
      // The socket may already be closed by the peer.
    }
    this.emitForSession(session, { type: 'closed' });
  }

  private handleMessage(session: StreamingSession, raw: RawData) {
    let event: DashScopeAsrMessage;
    try {
      event = JSON.parse(raw.toString()) as DashScopeAsrMessage;
    } catch (error) {
      logger.debug('[QwenStreamingAsr] Ignoring non-JSON frame:', error);
      return;
    }

    const eventName = event.header?.event;
    if (event.header?.request_id) {
      session.requestId = event.header.request_id;
    }

    if (eventName === 'task-started') {
      session.started = true;
      this.clearTimer(session);
      session.startDeferred.resolve();
      this.emitForSession(session, { type: 'started' });
      return;
    }

    if (eventName === 'result-generated') {
      const sentence = event.payload?.output?.sentence;
      const text = sentence?.text?.trim();
      if (!text || sentence?.heartbeat) {
        return;
      }

      if (sentence?.end_time !== null && sentence?.end_time !== undefined) {
        if (session.currentSentence) {
          session.currentSentence = '';
        }
        session.finalizedSentences.push(text);
      } else {
        session.currentSentence = text;
      }

      this.emitForSession(session, {
        type: 'partial',
        text: this.getFullText(session),
        requestId: session.requestId,
      });
      return;
    }

    if (eventName === 'task-finished') {
      this.clearTimer(session);
      if (
        session.currentSentence &&
        !session.finalizedSentences.includes(session.currentSentence)
      ) {
        session.finalizedSentences.push(session.currentSentence);
        session.currentSentence = '';
      }
      this.completeWithAvailableText(session, { fromPartial: false });
      return;
    }

    if (eventName === 'task-failed') {
      const message =
        event.header?.error_message ||
        event.header?.error_code ||
        'Qwen streaming ASR task failed';
      if (
        session.finishing &&
        this.completeWithAvailableText(session, {
          fromPartial: true,
        })
      ) {
        logger.warn(
          '[QwenStreamingAsr] Using partial transcript after failure',
          {
            sessionId: session.id,
            reason: message,
          },
        );
        return;
      }
      this.failSession(session, new Error(message));
    }
  }

  async start(input: StreamingAsrStartInput = {}): Promise<{
    sessionId: string;
  }> {
    const config = this.getConfig();
    const sessionId = randomUUID();
    const taskId = randomUUID().replace(/-/g, '');
    const socket = this.createSocket(config.url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.workspace
          ? { 'X-DashScope-WorkSpace': config.workspace }
          : {}),
      },
      handshakeTimeout: START_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    const session: StreamingSession = {
      id: sessionId,
      turnId: input.turnId,
      taskId,
      socket,
      started: false,
      finishing: false,
      closed: false,
      finalizedSentences: [],
      currentSentence: '',
      startDeferred: createDeferred<void>(),
      finishDeferred: null,
      timer: null,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.handleMessage(session, data);
      }
    });
    socket.once('open', () => {
      this.sendJson(session, {
        header: {
          action: 'run-task',
          task_id: taskId,
          streaming: 'duplex',
        },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: config.model,
          input: {},
          parameters: {
            format: 'pcm',
            sample_rate: input.sampleRate || ASR_SAMPLE_RATE,
          },
        },
      }).catch((error: unknown) => {
        this.failSession(
          session,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    socket.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.failSession(session, new Error(`Qwen streaming ASR: ${message}`));
    });
    socket.once('close', () => {
      if (!session.closed) {
        this.failSession(
          session,
          new Error('Qwen streaming ASR connection closed unexpectedly'),
        );
      }
    });

    session.timer = setTimeout(() => {
      this.failSession(
        session,
        new Error('Qwen streaming ASR startup timed out'),
      );
    }, START_TIMEOUT_MS);
    session.timer.unref();

    await session.startDeferred.promise;
    return { sessionId };
  }

  async prepare(): Promise<{ sessionId: string }> {
    const prepared = this.preparedSessionId
      ? this.sessions.get(this.preparedSessionId)
      : null;
    if (
      prepared &&
      !prepared.closed &&
      prepared.started &&
      prepared.socket.readyState === WebSocket.OPEN
    ) {
      return { sessionId: prepared.id };
    }
    if (this.preparePromise) {
      return { sessionId: await this.preparePromise };
    }

    this.preparePromise = this.start({})
      .then(({ sessionId }) => {
        this.preparedSessionId = sessionId;
        return sessionId;
      })
      .finally(() => {
        this.preparePromise = null;
      });
    return { sessionId: await this.preparePromise };
  }

  claim(input: StreamingAsrClaimInput): { claimed: boolean } {
    const session = this.sessions.get(input.sessionId);
    const claimed = Boolean(
      this.preparedSessionId === input.sessionId &&
        session &&
        !session.closed &&
        session.started &&
        session.socket.readyState === WebSocket.OPEN,
    );
    if (!claimed || !session) {
      return { claimed: false };
    }
    session.turnId = input.turnId;
    this.preparedSessionId = null;
    this.emitForSession(session, { type: 'started' });
    return { claimed: true };
  }

  async sendAudio(input: StreamingAsrAudioInput): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session || !session.started || session.closed || session.finishing) {
      throw new Error('Qwen streaming ASR session is not accepting audio');
    }
    const audio = input.audio
      ? Buffer.from(input.audio)
      : Buffer.from(input.audioBase64 || '', 'base64');
    if (!audio.length) {
      return;
    }
    if (audio.length > MAX_AUDIO_CHUNK_BYTES) {
      throw new Error('Qwen streaming ASR audio chunk is too large');
    }
    await new Promise<void>((resolve, reject) => {
      session.socket.send(audio, { binary: true }, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async finish(sessionId: string): Promise<StreamingAsrFinishResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      throw new Error('Qwen streaming ASR session is not active');
    }
    if (session.finishDeferred) {
      return session.finishDeferred.promise;
    }

    session.finishing = true;
    session.finishStartedAt = Date.now();
    session.finishDeferred = createDeferred<StreamingAsrFinishResult>();
    session.timer = setTimeout(() => {
      const timeoutError = new Error(
        'Qwen streaming ASR final result timed out',
      );
      if (
        this.completeWithAvailableText(session, {
          fromPartial: true,
          error: timeoutError,
        })
      ) {
        logger.warn('[QwenStreamingAsr] Finalization timeout, using partial', {
          sessionId: session.id,
          waitedMs: this.finishTimeoutMs,
        });
      }
    }, this.finishTimeoutMs);
    session.timer.unref();

    try {
      await this.sendJson(session, {
        header: {
          action: 'finish-task',
          task_id: session.taskId,
          streaming: 'duplex',
        },
        payload: {
          input: {},
        },
      });
    } catch (error) {
      this.failSession(
        session,
        error instanceof Error
          ? error
          : new Error('Failed to finish Qwen streaming ASR'),
      );
    }
    return session.finishDeferred.promise;
  }

  cancel(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const error = new Error('Qwen streaming ASR session was cancelled');
      session.startDeferred.reject(error);
      session.finishDeferred?.reject(error);
      this.disposeSession(session);
    }
  }

  stopAll() {
    this.preparedSessionId = null;
    this.preparePromise = null;
    for (const session of this.sessions.values()) {
      const error = new Error('Qwen streaming ASR service stopped');
      session.startDeferred.reject(error);
      session.finishDeferred?.reject(error);
      this.disposeSession(session);
    }
  }

  private async sendJson(session: StreamingSession, payload: unknown) {
    if (session.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Qwen streaming ASR WebSocket is not open');
    }
    await new Promise<void>((resolve, reject) => {
      session.socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

export const streamingAsrService = new DashScopeStreamingAsrService();

export const normalizeQwenStreamingAsrUrl = normalizeWebSocketUrl;
