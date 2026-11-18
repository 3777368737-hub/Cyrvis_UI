import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
  },
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { KeywordGate } from './keyword-gate';

const repoRoot = path.resolve(process.cwd(), '../../..');
const modelDir = path.join(
  repoRoot,
  'models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
);
const keywordsFile = path.join(
  process.cwd(),
  'resources/cyrvis/kws/keywords.txt',
);
const voiceprintModel = path.join(
  repoRoot,
  'models/voiceprint/3dspeaker_eres2net_base.onnx',
);
const voiceprintEmbedding = path.join(
  repoRoot,
  'models/voiceprint/user_embedding.f32',
);
const doubleTalk = path.join(repoRoot, 'models/voiceprint/doubletalk.wav');
const doubleTalkFar = path.join(
  repoRoot,
  'models/voiceprint/doubletalk-far.wav',
);
const ttsPause = path.join(
  process.cwd(),
  'src/main/cyrvis/__fixtures__/tts-pause-16k.wav',
);
const ttsStrong = path.join(
  process.cwd(),
  'src/main/cyrvis/__fixtures__/tts-bieshuole-16k.wav',
);

const hasFixtures =
  fs.existsSync(modelDir) &&
  fs.existsSync(keywordsFile) &&
  fs.existsSync(voiceprintModel) &&
  fs.existsSync(voiceprintEmbedding) &&
  fs.existsSync(doubleTalk) &&
  fs.existsSync(doubleTalkFar) &&
  fs.existsSync(ttsPause) &&
  fs.existsSync(ttsStrong);

type Hit = { keyword: string; at: number };
type Reject = { keyword: string; score: number | null; at: number };

const feedFile = (
  file: string,
  speakerMode: boolean,
  ttsContainsStop = false,
): { hits: Hit[]; rejects: Reject[] } => {
  process.env.CYRVIS_KWS_MODEL_DIR = modelDir;
  process.env.CYRVIS_KWS_KEYWORDS = keywordsFile;
  process.env.CYRVIS_VOICEPRINT_MODEL = voiceprintModel;
  process.env.CYRVIS_VOICEPRINT_EMBEDDING = voiceprintEmbedding;
  // The WAV is fed much faster than real time; wall-clock cooldown would
  // otherwise swallow later hits.
  process.env.CYRVIS_KWS_COOLDOWN_MS = '0';

  const hits: Hit[] = [];
  const rejects: Reject[] = [];
  const gate = new KeywordGate({
    onTrigger: (keyword) => hits.push({ keyword, at: -1 }),
    onReject: (keyword, score) => rejects.push({ keyword, score, at: -1 }),
  });
  expect(gate.load()).toBe(true);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa =
    require('sherpa-onnx-node') as typeof import('sherpa-onnx-node');
  const wav = sherpa.readWave(file);
  expect(wav.sampleRate).toBe(16000);

  const pcm = new Int16Array(wav.samples.length);
  for (let index = 0; index < wav.samples.length; index += 1) {
    pcm[index] = Math.max(
      -32768,
      Math.min(32767, Math.round(wav.samples[index] * 0x8000)),
    );
  }

  const recent: Int16Array[] = [];
  const chunkSize = 320;
  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    const chunk = pcm.subarray(offset, offset + chunkSize);
    recent.push(chunk.slice());
    if (recent.length > 50) {
      recent.shift();
    }
    const result = gate.feed(chunk, recent, speakerMode, { ttsContainsStop });
    if (result === 'triggered') {
      hits[hits.length - 1].at = offset / 16000;
    } else if (result === 'rejected') {
      rejects[rejects.length - 1].at = offset / 16000;
    }
  }

  return { hits, rejects };
};

const chunkRange = (
  samples: Float32Array,
  startSeconds: number,
  endSeconds: number,
): Int16Array[] => {
  const start = Math.floor(startSeconds * 16000);
  const end = Math.floor(endSeconds * 16000);
  const pcm = new Int16Array(end - start);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = Math.max(
      -32768,
      Math.min(32767, Math.round(samples[start + index] * 0x8000)),
    );
  }
  const chunks: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += 320) {
    chunks.push(pcm.subarray(offset, offset + 320).slice());
  }
  return chunks;
};

describe.skipIf(!hasFixtures)('KeywordGate real audio', () => {
  it('accepts the user stop words in speaker mode', () => {
    const { hits, rejects } = feedFile(doubleTalk, true);
    const keywords = hits.map((hit) => hit.keyword);
    expect(keywords.filter((keyword) => keyword === '别说了')).toHaveLength(2);
    // With the lower KWS threshold the model may collapse "停一下" to "停";
    // either is a valid stop command.
    expect(
      keywords.some((keyword) => keyword === '停' || keyword === '停一下'),
    ).toBe(true);
    expect(hits.every((hit) => hit.at >= 2.8)).toBe(true);
    expect(rejects).toHaveLength(0);
  }, 30_000);

  it('rejects the assistant saying 暂停/停止 through the speaker path', () => {
    // Local TTS: "好的，已暂停当前任务，要停止吗？". KWS correctly fires on
    // both "停" syllables; the voiceprint must reject them as not the user.
    const { hits, rejects } = feedFile(ttsPause, true, true);
    expect(hits).toHaveLength(0);
    expect(rejects).toHaveLength(2);
    expect(
      rejects.every((item) => item.score !== null && item.score < 0.25),
    ).toBe(true);
  }, 30_000);

  it('does not let a strong keyword bypass the check while TTS says it', () => {
    // Local TTS: "好的，别说了，我马上停止。". Strong keywords stop directly
    // only when the assistant is not saying a stop word; here ttsContainsStop
    // is true, so the voiceprint must reject the assistant's own voice.
    const { hits, rejects } = feedFile(ttsStrong, true, true);
    expect(hits).toHaveLength(0);
    expect(rejects.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('prefers the enrolled user over the TTS reference', () => {
    process.env.CYRVIS_KWS_MODEL_DIR = modelDir;
    process.env.CYRVIS_KWS_KEYWORDS = keywordsFile;
    process.env.CYRVIS_VOICEPRINT_MODEL = voiceprintModel;
    process.env.CYRVIS_VOICEPRINT_EMBEDDING = voiceprintEmbedding;
    const gate = new KeywordGate({ onTrigger: () => undefined });
    expect(gate.load()).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sherpa =
      require('sherpa-onnx-node') as typeof import('sherpa-onnx-node');
    const mic = sherpa.readWave(doubleTalk);
    const far = sherpa.readWave(doubleTalkFar);

    const user = gate.verifyRelative(
      chunkRange(mic.samples, 2.0, 3.0),
      far.samples.subarray(2 * 16000, 3 * 16000),
    );
    const tts = gate.verifyRelative(
      chunkRange(mic.samples, 1.2, 2.0),
      far.samples.subarray(1.2 * 16000, 2 * 16000),
    );

    expect(user).not.toBeNull();
    expect(user!.margin).toBeGreaterThan(0.05);
    expect(tts).not.toBeNull();
    expect(tts!.margin).toBeLessThan(0);
  }, 30_000);

  it('still uses voiceprint in headset mode when the model is available', () => {
    // The UI can report "headset" while playback is routed to Realtek. The
    // gate must not fall back to KWS-only in that configuration.
    const user = feedFile(doubleTalk, false);
    expect(user.hits.length).toBeGreaterThanOrEqual(3);
    const tts = feedFile(ttsPause, false, true);
    expect(tts.hits).toHaveLength(0);
    expect(tts.rejects).toHaveLength(2);
  }, 30_000);
});
