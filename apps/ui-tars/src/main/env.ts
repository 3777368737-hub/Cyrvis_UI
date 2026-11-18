/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import os from 'node:os';

import dotenv from 'dotenv';

dotenv.config();

export const mode = process.env.NODE_ENV;
export const isProd = mode === 'production';
export const isDev = mode === 'development';
export const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
export const port = process.env.PORT || 1212;
export const startMinimized = process.env.START_MINIMIZED;
export const rendererUrl = process.env.ELECTRON_RENDERER_URL;
export const isE2eTest = process.env.CI === 'e2e';

export const vlmProvider = process.env.VLM_PROVIDER;
export const vlmBaseUrl = process.env.VLM_BASE_URL;
export const vlmApiKey = process.env.VLM_API_KEY;
export const vlmModelName = process.env.VLM_MODEL_NAME;

export const conversationBaseUrl =
  process.env.CONVERSATION_BASE_URL ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const conversationApiKey =
  process.env.CONVERSATION_API_KEY || process.env.QWEN_API_KEY;
export const conversationModelName =
  process.env.CONVERSATION_MODEL_NAME || 'qwen-plus';

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
};

export const voiceEngine =
  (process.env.CYRVIS_VOICE_ENGINE as 'cascade' | 'omni' | undefined) || 'omni';
export const voiceEnabled = parseBoolean(process.env.VOICE_ENABLED, true);
export const voiceRequireWakeWord = parseBoolean(
  process.env.VOICE_REQUIRE_WAKE_WORD,
  true,
);
export const voiceWakeWord = process.env.VOICE_WAKE_WORD;
export const voiceLanguage = process.env.VOICE_LANGUAGE as
  | 'auto'
  | 'zh'
  | 'en'
  | undefined;
export const voiceSilenceTimeoutMs = Number(
  process.env.VOICE_SILENCE_TIMEOUT_MS || 600,
);
export const voiceSttProvider = process.env.VOICE_STT_PROVIDER as
  | 'auto'
  | 'openai-compatible'
  | 'tenlai-async'
  | 'qwen-dashscope-streaming'
  | 'local-sherpa'
  | 'realtime-asr'
  | undefined;
export const voiceSttBaseUrl = process.env.VOICE_STT_BASE_URL;
export const voiceSttApiKey =
  process.env.VOICE_STT_API_KEY ||
  process.env.DASHSCOPE_API_KEY ||
  process.env.QWEN_API_KEY;
export const voiceSttModel = process.env.VOICE_STT_MODEL;
export const voiceSttWorkspace =
  process.env.VOICE_STT_WORKSPACE || process.env.DASHSCOPE_WORKSPACE;
export const voiceTtsEnabled = parseBoolean(
  process.env.VOICE_TTS_ENABLED,
  true,
);
export const voiceTtsProvider = process.env.VOICE_TTS_PROVIDER as
  | 'auto'
  | 'breeze-local'
  | 'qwen-tts-realtime'
  | undefined;
export const voiceTtsBaseUrl = process.env.VOICE_TTS_BASE_URL;
export const voiceTtsApiKey = process.env.VOICE_TTS_API_KEY;
export const voiceTtsModel = process.env.VOICE_TTS_MODEL;
export const voiceTtsVoice = process.env.VOICE_TTS_VOICE;
export const voiceTtsInstruction = process.env.VOICE_TTS_INSTRUCTION;
export const voiceTtsCfgScale = process.env.VOICE_TTS_CFG_SCALE;
export const voiceTtsSeed = process.env.VOICE_TTS_SEED;
export const voiceTtsRuntimeDir = process.env.BREEZE_TTS_RUNTIME_DIR;
export const voiceTtsModelPath = process.env.BREEZE_TTS_MODEL_PATH;
export const voiceQwenTtsHttpBaseUrl = process.env.VOICE_QWEN_TTS_HTTP_BASE_URL;
export const voiceQwenTtsWsUrl = process.env.VOICE_QWEN_TTS_WS_URL;
export const voiceQwenTtsApiKey =
  process.env.VOICE_QWEN_TTS_API_KEY ||
  process.env.DASHSCOPE_API_KEY ||
  process.env.QWEN_API_KEY;
export const voiceQwenTtsWorkspace =
  process.env.VOICE_QWEN_TTS_WORKSPACE || process.env.DASHSCOPE_WORKSPACE;
export const voiceQwenTtsModel = process.env.VOICE_QWEN_TTS_MODEL;
export const voiceQwenTtsVoice = process.env.VOICE_QWEN_TTS_VOICE;
export const voiceQwenTtsVoiceModel = process.env.VOICE_QWEN_TTS_VOICE_MODEL;
export const voiceQwenTtsReferenceAudioPath =
  process.env.VOICE_QWEN_TTS_REFERENCE_AUDIO_PATH;
export const voiceQwenTtsPreferredName =
  process.env.VOICE_QWEN_TTS_PREFERRED_NAME;
export const voiceQwenTtsMode = process.env.VOICE_QWEN_TTS_MODE as
  | 'commit'
  | 'server_commit'
  | undefined;
export const voiceQwenTtsLanguage = process.env.VOICE_QWEN_TTS_LANGUAGE as
  | 'Auto'
  | 'Chinese'
  | 'English'
  | 'German'
  | 'Italian'
  | 'Portuguese'
  | 'Spanish'
  | 'Japanese'
  | 'Korean'
  | 'French'
  | 'Russian'
  | undefined;

const { platform } = process;
export const isMacOS = platform === 'darwin';

export const isWindows = platform === 'win32';

export const isLinux = platform === 'linux';

/**
 * @see https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information
 * Windows 11 buildNumber starts from 22000.
 */
const detectingWindows11 = () => {
  if (!isWindows) return false;

  const release = os.release();
  const majorVersion = Number.parseInt(release.split('.')[0]);
  const buildNumber = Number.parseInt(release.split('.')[2]);

  return majorVersion === 10 && buildNumber >= 22000;
};

export const isWindows11 = detectingWindows11();
