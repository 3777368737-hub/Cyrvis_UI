import { describe, expect, it } from 'vitest';

import {
  appendAudioPreroll,
  appendPcm16,
  calculateRms,
  downsamplePcm,
  floatToPcm16,
  takePcmChunks,
} from './audio';

describe('renderer streaming audio helpers', () => {
  it('measures RMS before downsampling to preserve barge sensitivity', () => {
    const raw = new Float32Array(4800);
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = index % 2 === 0 ? 0.08 : -0.08;
    }
    const downsampled = downsamplePcm(raw, 48000);
    const rawRms = calculateRms(raw);
    expect(rawRms).toBeGreaterThan(0.055);
    expect(calculateRms(downsampled)).toBeLessThan(rawRms / 2);
  });

  it('downsamples 48 kHz to 16 kHz', () => {
    const output = downsamplePcm(new Float32Array(4800).fill(0.25), 48000);
    expect(output).toHaveLength(1600);
    expect(output[0]).toBeCloseTo(0.25);
    expect(output[1599]).toBeCloseTo(0.25);
  });

  it('encodes little-endian PCM16', () => {
    expect(Array.from(floatToPcm16(new Float32Array([-1, 0, 1])))).toEqual([
      0, 128, 0, 0, 255, 127,
    ]);
  });

  it('sends PCM in 200 ms chunks', () => {
    const pcm = appendPcm16(new Uint8Array(6400), new Uint8Array(6400));
    const result = takePcmChunks(pcm);
    expect(result.chunks).toHaveLength(2);
    expect(result.remainder).toHaveLength(0);
  });

  it('keeps bounded pre-roll copies for barge-in recovery', () => {
    const source = new Float32Array([0.25, -0.25]);
    let preroll: Float32Array[] = [];
    for (let index = 0; index < 4; index += 1) {
      preroll = appendAudioPreroll(preroll, source, 3);
    }
    source[0] = 1;
    expect(preroll).toHaveLength(3);
    expect(preroll[0][0]).toBeCloseTo(0.25);
  });
});
