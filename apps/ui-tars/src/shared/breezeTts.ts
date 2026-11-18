/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type BreezeTtsStudioTab =
  | 'synthesize'
  | 'design'
  | 'clone'
  | 'direction'
  | 'convert'
  | 'library';

export const BREEZE_TTS_DEFAULT_SEED = 42;

export type BreezeTtsVoice = {
  id: string;
  frames: number;
  seconds: number;
  encode_ms: number;
  saved: boolean;
  ref_text: string;
  description?: string;
  metadata?: Record<string, string>;
};

export type BreezeTtsSynthesisInput = {
  text: string;
  instruction?: string;
  voiceId?: string;
  cfgScale?: number;
  seed?: number;
};

export const normalizeBreezeVoiceId = (voiceId?: string) => {
  const normalized = voiceId?.trim();
  return normalized && normalized.toLowerCase() !== 'alloy'
    ? normalized
    : undefined;
};

export const requireAvailableBreezeVoice = (
  voiceId: string | undefined,
  voices: Pick<BreezeTtsVoice, 'id'>[],
) => {
  const normalized = normalizeBreezeVoiceId(voiceId);
  if (!normalized) {
    return undefined;
  }
  if (!voices.some((voice) => voice.id === normalized)) {
    throw new Error(`Selected Breeze voice is unavailable: ${normalized}`);
  }
  return normalized;
};

export const normalizeBreezeTtsSeed = (seed?: number) =>
  Number.isFinite(seed)
    ? Math.max(0, Math.min(2_147_483_647, Math.trunc(seed!)))
    : undefined;

export type BreezeTtsSaveVoiceInput = {
  name: string;
  refText: string;
  description?: string;
  audioBase64: string;
  mimeType: string;
  fileName: string;
};

export type BreezeTtsConversionInput = {
  sourceAudioBase64: string;
  sourceMimeType: string;
  sourceFileName: string;
  sourceText?: string;
  voiceId: string;
  cfgScale?: number;
  keepAcoustic?: number;
};
