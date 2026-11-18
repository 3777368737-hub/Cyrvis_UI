import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENDPOINT_SILENCE_MS,
  MAX_ENDPOINT_SILENCE_MS,
  MID_SENTENCE_PAUSE_GRACE_MS,
  MIN_ENDPOINT_SILENCE_MS,
  resolveEndpointSilenceMs,
  shouldFinishStreamingUtterance,
} from './voiceEndpoint';

describe('renderer voice endpoint', () => {
  it('clamps stale settings to UI-tars bounds', () => {
    expect(resolveEndpointSilenceMs(100)).toBe(MIN_ENDPOINT_SILENCE_MS);
    expect(resolveEndpointSilenceMs(900)).toBe(900);
    expect(resolveEndpointSilenceMs(undefined)).toBe(
      DEFAULT_ENDPOINT_SILENCE_MS,
    );
    expect(resolveEndpointSilenceMs(10_000)).toBe(MAX_ENDPOINT_SILENCE_MS);
  });

  it('waits for the minimum speech duration', () => {
    expect(
      shouldFinishStreamingUtterance({
        durationMs: 499,
        silenceMs: 5_000,
        configuredSilenceMs: 600,
        transcript: '好。',
      }),
    ).toBe(false);
  });

  it('adds mid-sentence grace when punctuation is absent', () => {
    expect(
      shouldFinishStreamingUtterance({
        durationMs: 2_000,
        silenceMs: 600,
        configuredSilenceMs: 600,
        transcript: '帮我打开浏览器',
      }),
    ).toBe(false);
    expect(
      shouldFinishStreamingUtterance({
        durationMs: 2_000,
        silenceMs: 600 + MID_SENTENCE_PAUSE_GRACE_MS,
        configuredSilenceMs: 600,
        transcript: '帮我打开浏览器',
      }),
    ).toBe(true);
  });
});
