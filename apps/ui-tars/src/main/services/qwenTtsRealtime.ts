/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow } from 'electron';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';
import {
  QWEN_TTS_AUDIO_CLONE_MODEL,
  QWEN_TTS_AUDIO_CLONE_WS_URL,
  QWEN_TTS_REALTIME_HTTP_BASE_URL,
  QWEN_TTS_REALTIME_MODEL,
  QWEN_TTS_REALTIME_PREFERRED_NAME,
  QWEN_TTS_SYSTEM_VOICE,
  QWEN_TTS_VOICE_ENROLLMENT_MODEL,
  type QwenTtsRealtimeAppendInput,
  type QwenTtsRealtimeLanguage,
  type QwenTtsRealtimeMode,
  type QwenTtsRealtimeSessionInput,
  type QwenTtsRealtimeSessionResult,
  type QwenTtsRealtimeStreamEvent,
  type QwenTtsProtocol,
  type QwenTtsVoiceEnrollmentInput,
  type QwenTtsVoiceEnrollmentResult,
} from '@shared/qwenTtsRealtime';

const MAX_REFERENCE_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_REFERENCE_AUDIO_SECONDS = 5;
const MAX_REFERENCE_AUDIO_SECONDS = 60;
const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 24_000;
const VOICE_READY_POLL_INTERVAL_MS = 1_000;
const VOICE_READY_TIMEOUT_MS = 120_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type QwenTtsConfig = {
  httpBaseUrl: string;
  wsUrl: string;
  apiKey: string;
  workspace?: string;
  model: string;
  protocol: QwenTtsProtocol;
  voice: string;
  voiceModel: string;
  mode: QwenTtsRealtimeMode;
  language: QwenTtsRealtimeLanguage;
};

type QwenTtsSession = {
  id: string;
  requestId?: string;
  socket: WebSocket;
  model: string;
  protocol: QwenTtsProtocol;
  voice: string;
  mode: QwenTtsRealtimeMode;
  language: QwenTtsRealtimeLanguage;
  sampleRate: number;
  started: boolean;
  finishing: boolean;
  closed: boolean;
  ready: Deferred<void>;
  finished: Deferred<void> | null;
  timer: NodeJS.Timeout | null;
};

type QwenTtsServiceOptions = {
  emit?: (event: QwenTtsRealtimeStreamEvent) => void;
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
  fetch?: typeof fetch;
  readReferenceAudio?: (path: string) => Promise<Buffer>;
  getConfig?: () => QwenTtsConfig;
  pollIntervalMs?: number;
  voiceReadyTimeoutMs?: number;
};

type QwenTtsEventPayload = QwenTtsRealtimeStreamEvent extends infer TEvent
  ? TEvent extends QwenTtsRealtimeStreamEvent
    ? Omit<TEvent, 'sessionId'>
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

const broadcastQwenTtsEvent = (event: QwenTtsRealtimeStreamEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('qwen-tts:stream', event);
    }
  });
};

const normalizeHttpBaseUrl = (value?: string) => {
  const url = new URL(value?.trim() || QWEN_TTS_REALTIME_HTTP_BASE_URL);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/api\/v1\/services\/audio\/tts\/customization$/, '')
    .replace(/\/api\/v1$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

export const resolveQwenTtsProtocol = (model?: string): QwenTtsProtocol =>
  model?.trim().toLowerCase().startsWith('qwen-audio-') &&
  model.trim().toLowerCase().includes('tts')
    ? 'qwen-audio-tts'
    : 'qwen3-realtime';

export const normalizeQwenTtsWebSocketUrl = (
  value: string | undefined,
  model: string,
) => {
  const protocol = resolveQwenTtsProtocol(model);
  const url = new URL(
    value?.trim() ||
      (protocol === 'qwen-audio-tts'
        ? QWEN_TTS_AUDIO_CLONE_WS_URL
        : 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  );
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(
      'Qwen Realtime TTS URL must use ws://, wss://, http://, or https://',
    );
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname =
      protocol === 'qwen-audio-tts'
        ? '/api-ws/v1/inference'
        : '/api-ws/v1/realtime';
  } else if (protocol === 'qwen-audio-tts') {
    url.pathname = url.pathname.replace(
      /\/api-ws\/v1\/realtime$/,
      '/api-ws/v1/inference',
    );
  } else {
    url.pathname = url.pathname.replace(
      /\/api-ws\/v1\/inference$/,
      '/api-ws/v1/realtime',
    );
  }
  if (protocol === 'qwen3-realtime') {
    url.searchParams.set('model', model);
  } else {
    url.searchParams.delete('model');
  }
  return url.toString();
};

const getAudioMimeType = (filePath: string) => {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    default:
      throw new Error('Qwen voice reference must be WAV, MP3, or M4A');
  }
};

export const getWavDurationSeconds = (audio: Buffer) => {
  if (
    audio.length < 44 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (
      chunkId === 'fmt ' &&
      chunkSize >= 16 &&
      dataOffset + 16 <= audio.length
    ) {
      byteRate = audio.readUInt32LE(dataOffset + 8);
    }
    if (
      chunkId === 'data' &&
      byteRate > 0 &&
      dataOffset + chunkSize <= audio.length
    ) {
      return chunkSize / byteRate;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
};

export const createQwenVoiceEnrollmentRequest = ({
  model,
  prefix,
  audio,
  mimeType,
  languageHints,
}: {
  model: string;
  prefix: string;
  audio: Buffer;
  mimeType: string;
  languageHints?: string[];
}) => ({
  model: QWEN_TTS_VOICE_ENROLLMENT_MODEL,
  input: {
    action: 'create_voice',
    target_model: model,
    prefix,
    audio: `data:${mimeType};base64,${audio.toString('base64')}`,
    ...(languageHints?.length ? { language_hints: languageHints } : {}),
  },
});

export const createQwenVoiceQueryRequest = (voiceId: string) => ({
  model: QWEN_TTS_VOICE_ENROLLMENT_MODEL,
  input: {
    action: 'query_voice',
    voice_id: voiceId,
  },
});

type QwenVoiceCustomizationResponse = {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    voice?: string;
    voice_id?: string;
    status?: string;
    target_model?: string;
  };
};

const getLanguageHints = (language: QwenTtsRealtimeLanguage) => {
  const hints: Partial<Record<QwenTtsRealtimeLanguage, string>> = {
    Chinese: 'zh',
    English: 'en',
    German: 'de',
    Italian: 'it',
    Portuguese: 'pt',
    Spanish: 'es',
    Japanese: 'ja',
    Korean: 'ko',
    French: 'fr',
    Russian: 'ru',
  };
  const hint = hints[language];
  return hint ? [hint] : undefined;
};

const toAudioBuffer = (raw: RawData) => {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return Buffer.from(raw);
};

export class QwenTtsRealtimeService {
  private readonly sessions = new Map<string, QwenTtsSession>();
  private enrollmentPromise: Promise<QwenTtsVoiceEnrollmentResult> | null =
    null;
  private readonly verifiedVoices = new Map<string, string>();
  private readonly emit: (event: QwenTtsRealtimeStreamEvent) => void;
  private readonly createSocket: (
    url: string,
    options: ClientOptions,
  ) => WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly readReferenceAudio: (path: string) => Promise<Buffer>;
  private readonly getConfig: () => QwenTtsConfig;
  private readonly pollIntervalMs: number;
  private readonly voiceReadyTimeoutMs: number;

  constructor(options: QwenTtsServiceOptions = {}) {
    this.emit = options.emit || broadcastQwenTtsEvent;
    this.createSocket =
      options.createSocket ||
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.fetchImpl = options.fetch || fetch;
    this.readReferenceAudio =
      options.readReferenceAudio || ((filePath) => readFile(filePath));
    this.getConfig = options.getConfig || this.resolveConfig;
    this.pollIntervalMs =
      options.pollIntervalMs ?? VOICE_READY_POLL_INTERVAL_MS;
    this.voiceReadyTimeoutMs =
      options.voiceReadyTimeoutMs ?? VOICE_READY_TIMEOUT_MS;
  }

  private resolveConfig = (): QwenTtsConfig => {
    const settings = SettingStore.getStore();
    const apiKey =
      settings.voiceQwenTtsApiKey?.trim() ||
      settings.voiceTtsApiKey?.trim() ||
      settings.conversationApiKey?.trim() ||
      '';
    if (!apiKey) {
      throw new Error(
        'Qwen API TTS API Key is not configured. Set VOICE_QWEN_TTS_API_KEY or QWEN_API_KEY.',
      );
    }
    const configuredModel =
      settings.voiceQwenTtsModel?.trim() || QWEN_TTS_REALTIME_MODEL;
    const model =
      !settings.voiceQwenTtsVoice?.trim() &&
      settings.voiceQwenTtsReferenceAudioPath?.trim()
        ? QWEN_TTS_AUDIO_CLONE_MODEL
        : configuredModel;
    const protocol = resolveQwenTtsProtocol(model);

    return {
      httpBaseUrl: normalizeHttpBaseUrl(settings.voiceQwenTtsHttpBaseUrl),
      wsUrl:
        settings.voiceQwenTtsWsUrl?.trim() ||
        (protocol === 'qwen-audio-tts'
          ? QWEN_TTS_AUDIO_CLONE_WS_URL
          : 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
      apiKey,
      workspace: settings.voiceQwenTtsWorkspace?.trim() || undefined,
      model,
      protocol,
      voice:
        settings.voiceQwenTtsVoice?.trim() ||
        settings.voiceTtsVoice?.trim() ||
        (protocol === 'qwen3-realtime' ? QWEN_TTS_SYSTEM_VOICE : ''),
      voiceModel: settings.voiceQwenTtsVoiceModel?.trim() || '',
      mode: settings.voiceQwenTtsMode || 'commit',
      language: settings.voiceQwenTtsLanguage || 'Chinese',
    };
  };

  private async postVoiceCustomization(
    config: QwenTtsConfig,
    body: unknown,
  ): Promise<QwenVoiceCustomizationResponse> {
    const response = await this.fetchImpl(
      `${config.httpBaseUrl}/api/v1/services/audio/tts/customization`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(config.workspace
            ? { 'X-DashScope-WorkSpace': config.workspace }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
    const raw = await response.text();
    let payload: QwenVoiceCustomizationResponse = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as QwenVoiceCustomizationResponse;
      } catch {
        throw new Error(
          `Qwen voice enrollment returned invalid JSON (${response.status})`,
        );
      }
    }
    if (!response.ok || payload.code) {
      throw new Error(
        `Qwen voice enrollment failed (${response.status}): ${
          payload.message || payload.code || raw.slice(0, 1500)
        }`,
      );
    }
    return payload;
  }

  private async waitForVoiceReady(config: QwenTtsConfig, voice: string) {
    const deadline = Date.now() + this.voiceReadyTimeoutMs;
    while (Date.now() <= deadline) {
      const payload = await this.postVoiceCustomization(
        config,
        createQwenVoiceQueryRequest(voice),
      );
      const status = payload.output?.status?.trim().toUpperCase();
      if (status === 'OK') {
        const targetModel = payload.output?.target_model?.trim();
        if (targetModel && targetModel !== config.model) {
          throw new Error(
            `Qwen voice ${voice} is bound to ${targetModel}, but the selected TTS model is ${config.model}.`,
          );
        }
        return targetModel || config.model;
      }
      if (status && status !== 'DEPLOYING') {
        throw new Error(`Qwen voice ${voice} is not usable (status ${status})`);
      }
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(
      `Qwen voice ${voice} is still processing after ${Math.round(
        this.voiceReadyTimeoutMs / 1000,
      )} seconds`,
    );
  }

  async ensureVoice(
    input: QwenTtsVoiceEnrollmentInput = {},
  ): Promise<QwenTtsVoiceEnrollmentResult> {
    const config = this.getConfig();
    if (config.protocol === 'qwen3-realtime') {
      if (input.force) {
        throw new Error(
          'qwen3-tts-flash-realtime only supports system voices. Select qwen-audio-3.1-tts-flash to create a cloned Voice ID.',
        );
      }
      return {
        voice: config.voice || QWEN_TTS_SYSTEM_VOICE,
        created: false,
        model: config.model,
      };
    }
    if (config.voice && !input.force) {
      if (config.voiceModel && config.voiceModel !== config.model) {
        throw new Error(
          `Qwen voice ${config.voice} was created for ${config.voiceModel}, but the selected TTS model is ${config.model}.`,
        );
      }
      if (
        !config.voiceModel &&
        this.verifiedVoices.get(config.voice) !== config.model
      ) {
        const voiceModel = await this.waitForVoiceReady(config, config.voice);
        this.verifiedVoices.set(config.voice, voiceModel);
        SettingStore.set('voiceQwenTtsVoiceModel', voiceModel);
      }
      return {
        voice: config.voice,
        created: false,
        model: config.model,
      };
    }
    if (this.enrollmentPromise) {
      return this.enrollmentPromise;
    }

    this.enrollmentPromise = (async () => {
      const settings = SettingStore.getStore();
      const referencePath =
        settings.voiceQwenTtsReferenceAudioPath?.trim() || '';
      if (!referencePath) {
        throw new Error(
          'Qwen voice cloning requires VOICE_QWEN_TTS_REFERENCE_AUDIO_PATH or a saved Voice ID.',
        );
      }
      const fileStats = await stat(referencePath);
      if (!fileStats.isFile()) {
        throw new Error(`Qwen voice reference is not a file: ${referencePath}`);
      }
      if (fileStats.size <= 0 || fileStats.size > MAX_REFERENCE_AUDIO_BYTES) {
        throw new Error(
          'Qwen voice reference must be between 1 byte and 10 MB',
        );
      }

      const audio = await this.readReferenceAudio(referencePath);
      const mimeType = getAudioMimeType(referencePath);
      if (mimeType === 'audio/wav') {
        const duration = getWavDurationSeconds(audio);
        if (
          duration !== null &&
          (duration < MIN_REFERENCE_AUDIO_SECONDS ||
            duration > MAX_REFERENCE_AUDIO_SECONDS)
        ) {
          throw new Error(
            `Qwen voice reference must be ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} seconds`,
          );
        }
      }

      const prefix =
        settings.voiceQwenTtsPreferredName
          ?.replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 10) || QWEN_TTS_REALTIME_PREFERRED_NAME;
      const payload = await this.postVoiceCustomization(
        config,
        createQwenVoiceEnrollmentRequest({
          model: config.model,
          prefix,
          audio,
          mimeType,
          languageHints: getLanguageHints(config.language),
        }),
      );
      const voice = payload.output?.voice || payload.output?.voice_id;
      if (!voice) {
        throw new Error('Qwen voice enrollment returned no voice ID');
      }
      SettingStore.set('voiceQwenTtsVoice', voice);
      const voiceModel = await this.waitForVoiceReady(config, voice);
      this.verifiedVoices.set(voice, voiceModel);
      SettingStore.set('voiceQwenTtsVoiceModel', voiceModel);
      logger.info('[QwenTtsRealtime] Voice enrollment completed', {
        model: config.model,
        voice,
      });
      return {
        voice,
        created: true,
        model: config.model,
      };
    })().finally(() => {
      this.enrollmentPromise = null;
    });
    return this.enrollmentPromise;
  }

  private emitForSession(session: QwenTtsSession, event: QwenTtsEventPayload) {
    this.emit({
      ...event,
      sessionId: session.id,
    } as QwenTtsRealtimeStreamEvent);
  }

  private clearTimer(session: QwenTtsSession) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  private disposeSession(session: QwenTtsSession) {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.clearTimer(session);
    this.sessions.delete(session.id);
    try {
      session.socket.close();
    } catch {
      // The remote endpoint may already have closed the socket.
    }
    this.emitForSession(session, { type: 'closed' });
  }

  private failSession(session: QwenTtsSession, error: Error) {
    if (session.closed) {
      return;
    }
    session.ready.reject(error);
    session.finished?.reject(error);
    this.emitForSession(session, {
      type: 'error',
      error: error.message,
    });
    this.disposeSession(session);
  }

  private sendJson(session: QwenTtsSession, payload: unknown) {
    if (session.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Qwen Realtime TTS WebSocket is not open');
    }
    return new Promise<void>((resolve, reject) => {
      session.socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private sendEvent(session: QwenTtsSession, event: Record<string, unknown>) {
    return this.sendJson(session, {
      event_id: `event_${randomUUID().replace(/-/g, '')}`,
      ...event,
    });
  }

  private sendAudioTaskEvent(
    session: QwenTtsSession,
    action: 'run-task' | 'continue-task' | 'finish-task',
    payload: Record<string, unknown>,
  ) {
    return this.sendJson(session, {
      header: {
        action,
        task_id: session.id,
        streaming: 'duplex',
      },
      payload,
    });
  }

  private handleMessage(session: QwenTtsSession, raw: RawData) {
    let event: {
      type?: string;
      header?: {
        event?: string;
        task_id?: string;
      };
      payload?: {
        output?: unknown;
        usage?: unknown;
      };
      session?: {
        sample_rate?: number;
        voice?: string;
      };
      delta?: string;
      error?: {
        message?: string;
        code?: string;
      };
    };
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      logger.debug('[QwenTtsRealtime] Ignoring malformed message:', error);
      return;
    }

    if (session.protocol === 'qwen-audio-tts') {
      const taskEvent = event.header?.event;
      if (taskEvent === 'task-started') {
        session.started = true;
        this.clearTimer(session);
        session.ready.resolve();
        return;
      }
      if (taskEvent === 'task-failed') {
        this.failSession(
          session,
          new Error(
            `Qwen Audio TTS task failed: ${JSON.stringify(
              event.payload || event.header || event,
            ).slice(0, 1500)}`,
          ),
        );
        return;
      }
      if (taskEvent === 'task-finished') {
        session.finished?.resolve();
        this.emitForSession(session, { type: 'completed' });
        this.disposeSession(session);
      }
      return;
    }

    if (event.type === 'session.created') {
      this.sendEvent(session, {
        type: 'session.update',
        session: {
          voice: session.voice,
          mode: session.mode,
          language_type: session.language,
          response_format: 'pcm',
          sample_rate: session.sampleRate,
        },
      }).catch((error: unknown) => {
        this.failSession(
          session,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return;
    }

    if (event.type === 'session.updated') {
      session.sampleRate = event.session?.sample_rate || session.sampleRate;
      session.started = true;
      this.clearTimer(session);
      session.ready.resolve();
      return;
    }

    if (event.type === 'response.audio.delta' && event.delta) {
      this.emitForSession(session, {
        type: 'audio',
        delta: event.delta,
        sampleRate: session.sampleRate,
      });
      return;
    }

    if (event.type === 'session.finished') {
      session.finished?.resolve();
      this.emitForSession(session, { type: 'completed' });
      this.disposeSession(session);
      return;
    }

    if (event.type === 'error') {
      this.failSession(
        session,
        new Error(
          event.error?.message ||
            event.error?.code ||
            'Qwen Realtime TTS failed',
        ),
      );
    }
  }

  async start(
    input: QwenTtsRealtimeSessionInput = {},
  ): Promise<QwenTtsRealtimeSessionResult> {
    const config = this.getConfig();
    const enrollment = await this.ensureVoice();
    const sessionId = randomUUID();
    const socket = this.createSocket(
      normalizeQwenTtsWebSocketUrl(config.wsUrl, config.model),
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(config.workspace
            ? { 'X-DashScope-WorkSpace': config.workspace }
            : {}),
        },
        handshakeTimeout: START_TIMEOUT_MS,
        perMessageDeflate: false,
      },
    );
    const session: QwenTtsSession = {
      id: sessionId,
      requestId: input.requestId,
      socket,
      model: config.model,
      protocol: config.protocol,
      voice: enrollment.voice,
      mode: input.mode || config.mode,
      language: input.language || config.language,
      sampleRate: SAMPLE_RATE,
      started: false,
      finishing: false,
      closed: false,
      ready: createDeferred<void>(),
      finished: null,
      timer: null,
    };
    this.sessions.set(sessionId, session);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (session.protocol === 'qwen-audio-tts') {
          this.emitForSession(session, {
            type: 'audio',
            delta: toAudioBuffer(raw).toString('base64'),
            sampleRate: session.sampleRate,
          });
        }
        return;
      }
      this.handleMessage(session, raw);
    });
    socket.once('error', (error) => {
      this.failSession(
        session,
        new Error(
          `Qwen Realtime TTS: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    });
    socket.once('close', () => {
      if (!session.closed) {
        this.failSession(
          session,
          new Error('Qwen Realtime TTS connection closed unexpectedly'),
        );
      }
    });
    const startAudioTask = () => {
      if (session.closed) {
        return;
      }
      void this.sendAudioTaskEvent(session, 'run-task', {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: session.model,
        parameters: {
          text_type: 'PlainText',
          voice: session.voice,
          format: 'pcm',
          sample_rate: session.sampleRate,
          volume: 50,
          rate: 1,
          pitch: 1,
          enable_ssml: false,
        },
        input: {},
      }).catch((error: unknown) => {
        this.failSession(
          session,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    };
    if (session.protocol === 'qwen-audio-tts') {
      if (socket.readyState === WebSocket.OPEN) {
        startAudioTask();
      } else {
        socket.once('open', startAudioTask);
      }
    }
    session.timer = setTimeout(() => {
      this.failSession(
        session,
        new Error('Qwen Realtime TTS startup timed out'),
      );
    }, START_TIMEOUT_MS);
    session.timer.unref();

    try {
      await session.ready.promise;
      return {
        sessionId,
        voice: session.voice,
        sampleRate: session.sampleRate,
        format: 'pcm',
        protocol: session.protocol,
      };
    } catch (error) {
      this.disposeSession(session);
      throw error;
    }
  }

  async append(input: QwenTtsRealtimeAppendInput) {
    const session = this.sessions.get(input.sessionId);
    if (!session || !session.started || session.closed || session.finishing) {
      throw new Error('Qwen Realtime TTS session is not accepting text');
    }
    const text = input.text.trim();
    if (!text) {
      return;
    }
    if (session.protocol === 'qwen-audio-tts') {
      await this.sendAudioTaskEvent(session, 'continue-task', {
        input: { text },
      });
      return;
    }
    await this.sendEvent(session, {
      type: 'input_text_buffer.append',
      text,
    });
    if (input.commit !== false) {
      await this.sendEvent(session, {
        type: 'input_text_buffer.commit',
      });
    }
  }

  async finish(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return;
    }
    if (session.finished) {
      return session.finished.promise;
    }
    session.finishing = true;
    session.finished = createDeferred<void>();
    session.timer = setTimeout(() => {
      this.failSession(
        session,
        new Error('Qwen Realtime TTS final audio timed out'),
      );
    }, FINISH_TIMEOUT_MS);
    session.timer.unref();
    try {
      if (session.protocol === 'qwen-audio-tts') {
        await this.sendAudioTaskEvent(session, 'finish-task', {
          input: {},
        });
      } else {
        await this.sendEvent(session, { type: 'session.finish' });
      }
    } catch (error) {
      this.failSession(
        session,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return session.finished.promise;
  }

  cancel(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ready.reject(new Error('Qwen Realtime TTS session cancelled'));
      session.finished?.resolve();
      this.disposeSession(session);
    }
  }

  stopAll() {
    for (const session of [...this.sessions.values()]) {
      session.ready.reject(new Error('Qwen Realtime TTS service stopped'));
      session.finished?.resolve();
      this.disposeSession(session);
    }
  }
}

export const qwenTtsRealtimeService = new QwenTtsRealtimeService();
