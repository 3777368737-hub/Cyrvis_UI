import path from 'node:path';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';

const SAMPLE_RATE = 16000;

type SherpaModule = {
  OfflineRecognizer: new (config: unknown) => {
    createStream: () => {
      acceptWaveform: (input: {
        samples: Float32Array;
        sampleRate: number;
      }) => void;
    };
    decode: (stream: unknown) => void;
    getResult: (stream: unknown) => { text?: string };
  };
};

let recognizer: InstanceType<SherpaModule['OfflineRecognizer']> | null = null;
let loadedModel = '';

/**
 * Local fallback for the cascade ASR when the cloud endpoint cannot accept
 * streaming PCM. Paraformer-small is a batch recognizer: the cascade VAD
 * buffers one utterance and transcribes it after the endpoint.
 */
const loadRecognizer = (
  modelPath: string,
): InstanceType<SherpaModule['OfflineRecognizer']> => {
  if (recognizer && loadedModel === modelPath) {
    return recognizer;
  }
  const tokens =
    process.env.CYRVIS_LOCAL_ASR_TOKENS ||
    path.join(path.dirname(modelPath), 'tokens.txt');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require('sherpa-onnx-node') as SherpaModule;
  const started = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      paraformer: { model: modelPath },
      tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  loadedModel = modelPath;
  logger.info('[cyrvis local asr] ready', {
    modelPath,
    tokens,
    loadMs: Date.now() - started,
  });
  return recognizer;
};

export const transcribeLocal = async (
  chunks: Int16Array[],
): Promise<string> => {
  const settings = SettingStore.getStore();
  const modelPath = (
    process.env.CYRVIS_LOCAL_ASR_MODEL ||
    settings.voiceSttModel ||
    ''
  ).trim();
  if (!modelPath) {
    throw new Error('Local ASR model path is not configured');
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!total) {
    return '';
  }
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      samples[offset + index] = chunk[index] / 0x8000;
    }
    offset += chunk.length;
  }

  const active = loadRecognizer(modelPath);
  const stream = active.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const started = Date.now();
  active.decode(stream);
  const result = active.getResult(stream);
  logger.info('[cyrvis local asr] decoded', {
    ms: Date.now() - started,
    samples: total,
    textLength: result.text?.length ?? 0,
  });
  return (result.text || '').trim();
};
