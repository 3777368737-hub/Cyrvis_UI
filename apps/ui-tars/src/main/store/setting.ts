/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import ElectronStore from 'electron-store';
import yaml from 'js-yaml';

import * as env from '@main/env';
import { logger } from '@main/logger';

import {
  LocalStore,
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
  WidgetOverlayMode,
} from './types';
import {
  BREEZE_TTS_DEFAULT_BASE_URL,
  BREEZE_TTS_DEFAULT_INSTRUCTION,
  BREEZE_TTS_DEFAULT_SEED,
  BREEZE_TTS_MODEL,
  QWEN_ASR_DEFAULT_WS_URL,
  QWEN_ASR_MODEL,
  VOICE_DEFAULT_SILENCE_TIMEOUT_MS,
} from '@shared/voice';
import {
  QWEN_TTS_AUDIO_CLONE_MODEL,
  QWEN_TTS_AUDIO_CLONE_WS_URL,
  QWEN_TTS_REALTIME_HTTP_BASE_URL,
  QWEN_TTS_REALTIME_PREFERRED_NAME,
} from '@shared/qwenTtsRealtime';
import { validatePreset } from './validate';
import { BrowserWindow } from 'electron';

export const DEFAULT_SETTING: LocalStore = {
  language: 'en',
  vlmProvider: (env.vlmProvider as VLMProviderV2) || '',
  vlmBaseUrl: env.vlmBaseUrl || '',
  vlmApiKey: env.vlmApiKey || '',
  vlmModelName: env.vlmModelName || '',
  useResponsesApi: false,
  conversationBaseUrl: env.conversationBaseUrl || '',
  conversationApiKey: env.conversationApiKey || '',
  conversationModelName: env.conversationModelName || '',
  voiceEngine: env.voiceEngine,
  voiceEnabled: env.voiceEnabled,
  voiceRequireWakeWord: env.voiceRequireWakeWord,
  voiceWakeWord: env.voiceWakeWord || '小T',
  voiceLanguage: env.voiceLanguage || 'zh',
  voiceSilenceTimeoutMs:
    env.voiceSilenceTimeoutMs || VOICE_DEFAULT_SILENCE_TIMEOUT_MS,
  voiceSttProvider: env.voiceSttProvider || 'auto',
  voiceSttBaseUrl: env.voiceSttBaseUrl || QWEN_ASR_DEFAULT_WS_URL,
  voiceSttApiKey: env.voiceSttApiKey || '',
  voiceSttModel: env.voiceSttModel || QWEN_ASR_MODEL,
  voiceTtsEnabled: env.voiceTtsEnabled,
  voiceTtsProvider: env.voiceTtsProvider || 'breeze-local',
  voiceTtsBaseUrl: env.voiceTtsBaseUrl || BREEZE_TTS_DEFAULT_BASE_URL,
  voiceTtsApiKey: env.voiceTtsApiKey || 'local-breeze',
  voiceTtsModel: env.voiceTtsModel || BREEZE_TTS_MODEL,
  voiceTtsVoice: env.voiceTtsVoice || '',
  voiceTtsInstruction:
    env.voiceTtsInstruction || BREEZE_TTS_DEFAULT_INSTRUCTION,
  voiceTtsCfgScale: env.voiceTtsCfgScale ? Number(env.voiceTtsCfgScale) : 1,
  voiceTtsSeed: env.voiceTtsSeed
    ? Number(env.voiceTtsSeed)
    : BREEZE_TTS_DEFAULT_SEED,
  voiceTtsRuntimeDir: env.voiceTtsRuntimeDir || '',
  voiceTtsModelPath: env.voiceTtsModelPath || '',
  voiceQwenTtsHttpBaseUrl:
    env.voiceQwenTtsHttpBaseUrl || QWEN_TTS_REALTIME_HTTP_BASE_URL,
  voiceQwenTtsWsUrl: env.voiceQwenTtsWsUrl || QWEN_TTS_AUDIO_CLONE_WS_URL,
  voiceQwenTtsApiKey: env.voiceQwenTtsApiKey || '',
  voiceQwenTtsWorkspace: env.voiceQwenTtsWorkspace || '',
  voiceQwenTtsProfileVersion: 2,
  voiceQwenTtsModel: env.voiceQwenTtsModel || QWEN_TTS_AUDIO_CLONE_MODEL,
  voiceQwenTtsVoice: env.voiceQwenTtsVoice || '',
  voiceQwenTtsVoiceModel: env.voiceQwenTtsVoiceModel || '',
  voiceQwenTtsReferenceAudioPath: env.voiceQwenTtsReferenceAudioPath || '',
  voiceQwenTtsPreferredName:
    env.voiceQwenTtsPreferredName || QWEN_TTS_REALTIME_PREFERRED_NAME,
  voiceQwenTtsMode: env.voiceQwenTtsMode || 'commit',
  voiceQwenTtsLanguage: env.voiceQwenTtsLanguage || 'Chinese',
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
  widgetOverlayMode: WidgetOverlayMode.AlwaysOnTop,
  operator: Operator.LocalComputer,
  reportStorageBaseUrl: '',
  utioBaseUrl: '',
};

const SENSITIVE_SETTING_KEY = /(api[-_]?key|token|secret|password)/i;

const redactSettings = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactSettings);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_SETTING_KEY.test(key)
        ? '***'
        : redactSettings(entry);
    }
    return output;
  }
  return value;
};

export class SettingStore {
  private static instance: ElectronStore<LocalStore>;

  public static getInstance(): ElectronStore<LocalStore> {
    if (!SettingStore.instance) {
      SettingStore.instance = new ElectronStore<LocalStore>({
        name: 'ui_tars.setting',
        defaults: DEFAULT_SETTING,
      });

      SettingStore.instance.onDidAnyChange((newValue, oldValue) => {
        logger.log(
          `SettingStore: ${JSON.stringify(
            redactSettings(oldValue),
          )} changed to ${JSON.stringify(redactSettings(newValue))}`,
        );
        // Notify that value updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('setting-updated', newValue);
        });
      });
    }
    return SettingStore.instance;
  }

  public static set<K extends keyof LocalStore>(
    key: K,
    value: LocalStore[K],
  ): void {
    SettingStore.getInstance().set(key, value);
  }

  public static setStore(state: LocalStore): void {
    SettingStore.getInstance().set(state);
  }

  public static get<K extends keyof LocalStore>(key: K): LocalStore[K] {
    return SettingStore.getInstance().get(key);
  }

  public static remove<K extends keyof LocalStore>(key: K): void {
    SettingStore.getInstance().delete(key);
  }

  public static getStore(): LocalStore {
    return SettingStore.getInstance().store;
  }

  public static clear(): void {
    SettingStore.getInstance().set(DEFAULT_SETTING);
  }

  public static openInEditor(): void {
    SettingStore.getInstance().openInEditor();
  }

  public static async importPresetFromUrl(
    url: string,
    autoUpdate = false,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch preset: ${response.status}`);
      }

      const yamlText = await response.text();
      const preset = yaml.load(yamlText);
      const validatedPreset = validatePreset(preset);

      SettingStore.setStore({
        ...validatedPreset,
        presetSource: {
          type: 'remote',
          url,
          autoUpdate,
          lastUpdated: Date.now(),
        },
      });
    } catch (error) {
      logger.error(error);
      throw new Error(
        `Failed to import preset: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public static async importPresetFromText(
    yamlContent: string,
  ): Promise<LocalStore> {
    try {
      const settings = await parsePresetYaml(yamlContent);
      return settings;
    } catch (error) {
      logger.error('Failed to import preset from text:', error);
      throw error;
    }
  }

  public static async fetchPresetFromUrl(url: string): Promise<LocalStore> {
    try {
      const response = await fetch(url);
      const yamlContent = await response.text();
      return await this.importPresetFromText(yamlContent);
    } catch (error) {
      logger.error('Failed to fetch preset from URL:', error);
      throw error;
    }
  }
}

async function parsePresetYaml(yamlContent: string): Promise<LocalStore> {
  const preset = yaml.load(yamlContent);
  const validatedPreset = validatePreset(preset);
  return validatedPreset;
}
