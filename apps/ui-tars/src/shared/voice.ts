/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QWEN_TTS_REALTIME_PROVIDER } from './qwenTtsRealtime';

export const QWEN_ASR_DEFAULT_WS_URL =
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
export const QWEN_ASR_MODEL = 'qwen-audio-3.1-asr-flash-streaming';
export const TENLAI_ASR_DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com';
export const TENLAI_ASR_MODEL = 'tenlai-asr-v1.0';
export const VOICE_DEFAULT_SILENCE_TIMEOUT_MS = 600;
export const VOICE_MIN_SILENCE_TIMEOUT_MS = 400;
export const VOICE_MAX_SILENCE_TIMEOUT_MS = 4000;
export const BREEZE_TTS_DEFAULT_BASE_URL = 'http://127.0.0.1:8137/v1';
export const BREEZE_TTS_MODEL = 'breeze-tts-2';
export const BREEZE_TTS_START_TIMEOUT_MS = 180_000;
export const BREEZE_TTS_DEFAULT_INSTRUCTION =
  '清晰、自然、亲切的年轻中文女声，语速适中。';
export { BREEZE_TTS_DEFAULT_SEED } from './breezeTts';

export type VoiceSttProvider =
  | 'auto'
  | 'openai-compatible'
  | 'tenlai-async'
  | 'qwen-dashscope-streaming'
  | 'local-sherpa'
  | 'realtime-asr';

export type ResolvedVoiceSttProvider =
  | 'openai-compatible'
  | 'tenlai-async'
  | 'qwen-dashscope-streaming'
  | 'local-sherpa'
  | 'realtime-asr';

export type VoiceTtsProvider = 'auto' | 'breeze-local' | 'qwen-tts-realtime';

export type ResolvedVoiceTtsProvider = 'breeze-local' | 'qwen-tts-realtime';

export const isQwenStreamingAsrModel = (model?: string) =>
  model?.trim().toLowerCase().includes('qwen-audio') &&
  model.trim().toLowerCase().includes('asr') &&
  model.trim().toLowerCase().includes('streaming');

export const isTenlaiAsrModel = (model?: string) =>
  model?.trim().toLowerCase().startsWith('tenlai-asr') ?? false;

export const resolveVoiceSttProvider = (
  provider: VoiceSttProvider | undefined,
  model: string | undefined,
): ResolvedVoiceSttProvider => {
  if (
    provider === 'openai-compatible' ||
    provider === 'tenlai-async' ||
    provider === 'qwen-dashscope-streaming' ||
    provider === 'local-sherpa' ||
    provider === 'realtime-asr'
  ) {
    return provider;
  }
  if (isQwenStreamingAsrModel(model)) {
    return 'qwen-dashscope-streaming';
  }
  return isTenlaiAsrModel(model) ? 'tenlai-async' : 'openai-compatible';
};

export const isBreezeTtsEndpoint = (baseUrl?: string) => {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return (
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      url.port === '8137'
    );
  } catch {
    return false;
  }
};

export const toBreezeTtsWebSocketUrl = (baseUrl?: string) => {
  try {
    const url = new URL(baseUrl || BREEZE_TTS_DEFAULT_BASE_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const httpPort = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
    url.port = String(httpPort + 1);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'ws://127.0.0.1:8138';
  }
};

export const resolveVoiceTtsProvider = (
  provider: VoiceTtsProvider | undefined,
  baseUrl?: string,
  model?: string,
): ResolvedVoiceTtsProvider => {
  if (provider === 'breeze-local' || provider === QWEN_TTS_REALTIME_PROVIDER) {
    return provider;
  }
  return isBreezeTtsEndpoint(baseUrl) ||
    model?.trim().toLowerCase().startsWith('breeze')
    ? 'breeze-local'
    : QWEN_TTS_REALTIME_PROVIDER;
};
