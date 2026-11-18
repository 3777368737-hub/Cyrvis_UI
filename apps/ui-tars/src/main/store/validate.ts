/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

import {
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
  WidgetOverlayMode,
} from './types';
import {
  VOICE_MAX_SILENCE_TIMEOUT_MS,
  VOICE_MIN_SILENCE_TIMEOUT_MS,
  type VoiceSttProvider,
  type VoiceTtsProvider,
} from '@shared/voice';
import type {
  QwenTtsRealtimeLanguage,
  QwenTtsRealtimeMode,
} from '@shared/qwenTtsRealtime';

const PresetSourceSchema = z.object({
  type: z.enum(['local', 'remote']),
  url: z.string().url().optional(),
  autoUpdate: z.boolean().optional(),
  lastUpdated: z.number().optional(),
});

export const PresetSchema = z.object({
  // Local VLM Settings
  vlmProvider: z.nativeEnum(VLMProviderV2).optional(),
  vlmBaseUrl: z.string().url(),
  vlmApiKey: z.string().min(1),
  vlmModelName: z.string().min(1),
  useResponsesApi: z.boolean().optional(),

  // Conversation Settings
  conversationBaseUrl: z.string().url().optional().or(z.literal('')),
  conversationApiKey: z.string().optional(),
  conversationModelName: z.string().optional(),

  // Voice Settings
  voiceEngine: z.enum(['cascade', 'omni']).optional(),
  voiceEnabled: z.boolean().optional(),
  voiceRequireWakeWord: z.boolean().optional(),
  voiceWakeWord: z.string().optional(),
  voiceLanguage: z.enum(['auto', 'zh', 'en']).optional(),
  voiceSilenceTimeoutMs: z
    .number()
    .int()
    .min(VOICE_MIN_SILENCE_TIMEOUT_MS)
    .max(VOICE_MAX_SILENCE_TIMEOUT_MS)
    .optional(),
  voiceSttProvider: z
    .enum([
      'auto',
      'openai-compatible',
      'tenlai-async',
      'qwen-dashscope-streaming',
      'local-sherpa',
      'realtime-asr',
    ])
    .optional()
    .transform((value) => value as VoiceSttProvider | undefined),
  voiceSttBaseUrl: z.string().url().optional().or(z.literal('')),
  voiceSttApiKey: z.string().optional(),
  voiceSttModel: z.string().optional(),
  voiceTtsEnabled: z.boolean().optional(),
  voiceTtsProvider: z
    .enum(['auto', 'breeze-local', 'qwen-tts-realtime'])
    .optional()
    .transform((value) => value as VoiceTtsProvider | undefined),
  voiceTtsBaseUrl: z.string().url().optional().or(z.literal('')),
  voiceTtsApiKey: z.string().optional(),
  voiceTtsModel: z.string().optional(),
  voiceTtsVoice: z.string().optional(),
  voiceTtsInstruction: z.string().optional(),
  voiceTtsCfgScale: z.number().min(1).max(3).optional(),
  voiceTtsSeed: z.number().int().min(0).max(2_147_483_647).optional(),
  voiceTtsRuntimeDir: z.string().optional(),
  voiceTtsModelPath: z.string().optional(),
  voiceQwenTtsHttpBaseUrl: z.string().url().optional().or(z.literal('')),
  voiceQwenTtsWsUrl: z.string().url().optional().or(z.literal('')),
  voiceQwenTtsApiKey: z.string().optional(),
  voiceQwenTtsWorkspace: z.string().optional(),
  voiceQwenTtsProfileVersion: z.number().int().min(1).optional(),
  voiceQwenTtsModel: z.string().optional(),
  voiceQwenTtsVoice: z.string().optional(),
  voiceQwenTtsVoiceModel: z.string().optional(),
  voiceQwenTtsReferenceAudioPath: z.string().optional(),
  voiceQwenTtsPreferredName: z.string().optional(),
  voiceQwenTtsMode: z
    .enum(['commit', 'server_commit'])
    .optional()
    .transform((value) => value as QwenTtsRealtimeMode | undefined),
  voiceQwenTtsLanguage: z
    .enum([
      'Auto',
      'Chinese',
      'English',
      'German',
      'Italian',
      'Portuguese',
      'Spanish',
      'Japanese',
      'Korean',
      'French',
      'Russian',
    ])
    .optional()
    .transform((value) => value as QwenTtsRealtimeLanguage | undefined),

  // Chat Settings
  operator: z.nativeEnum(Operator),
  language: z.enum(['zh', 'en']).optional(),
  screenshotScale: z.number().min(0.1).max(1).optional(),
  maxLoopCount: z.number().min(25).max(200).optional(),
  loopIntervalInMs: z.number().min(0).max(3000).optional(),
  searchEngineForBrowser: z.nativeEnum(SearchEngineForSettings).optional(),
  widgetOverlayMode: z.nativeEnum(WidgetOverlayMode).optional(),

  // Report Settings
  reportStorageBaseUrl: z.string().url().optional(),
  utioBaseUrl: z.string().url().optional(),
  presetSource: PresetSourceSchema.optional(),
});

export type PresetSource = z.infer<typeof PresetSourceSchema>;
export type LocalStore = z.infer<typeof PresetSchema>;

export const validatePreset = (data: unknown): LocalStore => {
  return PresetSchema.parse(data);
};
