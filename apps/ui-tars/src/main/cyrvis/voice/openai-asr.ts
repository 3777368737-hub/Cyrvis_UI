/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

import { SettingStore } from '@main/store/setting';

const SAMPLE_RATE = 16_000;

const wrapPcmAsWav = (pcm: Buffer) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

export const transcribeOpenAiCompatible = async (
  chunks: Int16Array[],
  language?: 'auto' | 'zh' | 'en',
): Promise<string> => {
  const settings = SettingStore.getStore();
  const baseURL = settings.voiceSttBaseUrl?.trim();
  const apiKey = settings.voiceSttApiKey?.trim();
  const model = settings.voiceSttModel?.trim();
  if (!baseURL || !apiKey || !model) {
    throw new Error(
      'OpenAI-compatible ASR requires Base URL, API Key, and model.',
    );
  }
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = Buffer.alloc(samples * 2);
  let offset = 0;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      pcm.writeInt16LE(sample, offset);
      offset += 2;
    }
  }
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 1 });
  const file = await toFile(wrapPcmAsWav(pcm), 'utterance.wav', {
    type: 'audio/wav',
  });
  const result = await client.audio.transcriptions.create(
    {
      file,
      model,
      response_format: 'json',
      ...(language && language !== 'auto' ? { language } : {}),
    },
    { timeout: 60_000 },
  );
  return result.text?.trim() || '';
};
