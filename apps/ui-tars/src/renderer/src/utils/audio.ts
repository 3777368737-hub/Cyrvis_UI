/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export const QWEN_ASR_SAMPLE_RATE = 16_000;
export const QWEN_ASR_CHUNK_SAMPLES = 3200;

export const calculateRms = (samples: Float32Array) => {
  if (!samples.length) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
};

export const downsamplePcm = (
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = QWEN_ASR_SAMPLE_RATE,
) => {
  if (inputSampleRate <= outputSampleRate) {
    return new Float32Array(input);
  }
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  let inputOffset = 0;
  for (let outputOffset = 0; outputOffset < outputLength; outputOffset += 1) {
    const nextInputOffset = Math.round((outputOffset + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (
      let inputIndex = inputOffset;
      inputIndex < nextInputOffset && inputIndex < input.length;
      inputIndex += 1
    ) {
      sum += input[inputIndex];
      count += 1;
    }
    output[outputOffset] = count ? sum / count : 0;
    inputOffset = nextInputOffset;
  }
  return output;
};

export const floatToPcm16 = (
  samples: Float32Array,
): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(value), true);
  }
  return bytes;
};

export const appendPcm16 = (
  pending: Uint8Array,
  next: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  if (!pending.length) {
    return new Uint8Array(next);
  }
  const merged = new Uint8Array(pending.length + next.length);
  merged.set(pending);
  merged.set(next, pending.length);
  return merged;
};

export const appendAudioPreroll = (
  preroll: Float32Array[],
  samples: Float32Array,
  maximumChunks: number,
) => {
  const next = [...preroll, new Float32Array(samples)];
  return next.length > maximumChunks
    ? next.slice(next.length - maximumChunks)
    : next;
};

export const takePcmChunks = (
  pending: Uint8Array,
  minimumBytes = QWEN_ASR_CHUNK_SAMPLES * 2,
) => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (pending.length - offset >= minimumBytes) {
    chunks.push(new Uint8Array(pending.slice(offset, offset + minimumBytes)));
    offset += minimumBytes;
  }
  return {
    chunks,
    remainder: new Uint8Array(pending.slice(offset)),
  };
};
