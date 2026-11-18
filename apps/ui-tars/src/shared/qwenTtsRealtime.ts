/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export const QWEN_TTS_REALTIME_PROVIDER = 'qwen-tts-realtime';
export const QWEN_TTS_REALTIME_MODEL = 'qwen3-tts-flash-realtime';
export const QWEN_TTS_AUDIO_CLONE_MODEL = 'qwen-audio-3.1-tts-flash';
export const QWEN_TTS_SYSTEM_VOICE = 'Cherry';
export const QWEN_TTS_VOICE_ENROLLMENT_MODEL = 'voice-enrollment';
export const QWEN_TTS_REALTIME_HTTP_BASE_URL = 'https://dashscope.aliyuncs.com';
export const QWEN_TTS_REALTIME_WS_URL =
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const QWEN_TTS_AUDIO_CLONE_WS_URL =
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
export const QWEN_TTS_REALTIME_PREFERRED_NAME = 'cyrvis';
export const QWEN_TTS_REALTIME_REFERENCE_AUDIO_PATH = '';

export type QwenTtsRealtimeMode = 'commit' | 'server_commit';
export type QwenTtsProtocol = 'qwen3-realtime' | 'qwen-audio-tts';

export type QwenTtsRealtimeLanguage =
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
  | 'Russian';

export type QwenTtsVoiceEnrollmentInput = {
  force?: boolean;
};

export type QwenTtsVoiceEnrollmentResult = {
  voice: string;
  created: boolean;
  model: string;
};

export type QwenTtsRealtimeSessionInput = {
  requestId?: string;
  mode?: QwenTtsRealtimeMode;
  language?: QwenTtsRealtimeLanguage;
};

export type QwenTtsRealtimeSessionResult = {
  sessionId: string;
  voice: string;
  sampleRate: number;
  format: 'pcm';
  protocol: QwenTtsProtocol;
};

export type QwenTtsRealtimeAppendInput = {
  sessionId: string;
  text: string;
  commit?: boolean;
};

export type QwenTtsRealtimeSessionActionInput = {
  sessionId: string;
};

export type QwenTtsRealtimeStreamEvent =
  | {
      type: 'audio';
      sessionId: string;
      delta: string;
      sampleRate: number;
    }
  | {
      type: 'completed';
      sessionId: string;
    }
  | {
      type: 'error';
      sessionId: string;
      error: string;
    }
  | {
      type: 'closed';
      sessionId: string;
    };
