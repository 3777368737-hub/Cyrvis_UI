/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  VOICE_DEFAULT_SILENCE_TIMEOUT_MS,
  VOICE_MAX_SILENCE_TIMEOUT_MS,
  VOICE_MIN_SILENCE_TIMEOUT_MS,
} from '../../../shared/voice';

export const DEFAULT_ENDPOINT_SILENCE_MS = VOICE_DEFAULT_SILENCE_TIMEOUT_MS;
export const MIN_ENDPOINT_SILENCE_MS = VOICE_MIN_SILENCE_TIMEOUT_MS;
export const MAX_ENDPOINT_SILENCE_MS = VOICE_MAX_SILENCE_TIMEOUT_MS;
export const MIN_STREAMING_SPEECH_MS = 500;
export const MAX_STREAMING_UTTERANCE_MS = 5 * 60_000;
export const MID_SENTENCE_PAUSE_GRACE_MS = 200;

export const resolveEndpointSilenceMs = (configuredMs?: number) =>
  Math.min(
    MAX_ENDPOINT_SILENCE_MS,
    Math.max(
      MIN_ENDPOINT_SILENCE_MS,
      Number.isFinite(configuredMs)
        ? Math.trunc(configuredMs!)
        : DEFAULT_ENDPOINT_SILENCE_MS,
    ),
  );

export const shouldFinishStreamingUtterance = ({
  durationMs,
  silenceMs,
  configuredSilenceMs,
  transcript,
}: {
  durationMs: number;
  silenceMs: number;
  configuredSilenceMs?: number;
  transcript?: string;
}) => {
  if (durationMs < MIN_STREAMING_SPEECH_MS) {
    return false;
  }
  if (durationMs >= MAX_STREAMING_UTTERANCE_MS) {
    return true;
  }
  const trimmedTranscript = transcript?.trimEnd() || '';
  const endsAtSentenceBoundary = /[。！？?!]["'”’]?$/u.test(trimmedTranscript);
  const requiredSilenceMs =
    resolveEndpointSilenceMs(configuredSilenceMs) +
    (trimmedTranscript && !endsAtSentenceBoundary
      ? MID_SENTENCE_PAUSE_GRACE_MS
      : 0);
  return silenceMs >= requiredSilenceMs;
};
