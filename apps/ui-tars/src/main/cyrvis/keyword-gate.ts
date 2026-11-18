import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { logger } from '@main/logger';

type SherpaModule = typeof import('sherpa-onnx-node');

const KWS_DIR_NAME = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
const KWS_ENCODER = 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx';
const KWS_DECODER = 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx';
const KWS_JOINER = 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx';
const VOICEPRINT_MODEL = '3dspeaker_eres2net_base.onnx';
const VOICEPRINT_EMBEDDING = 'user_embedding.f32';
const SAMPLE_RATE = 16000;
// One second of audio gives a noticeably more stable embedding than 0.96s,
// especially for the very short bare "停".
const VERIFY_CHUNKS = 50;
const MIN_VERIFY_SAMPLES = 8000;
const DEFAULT_THRESHOLD = 0.22;
// Long, specific commands are unlikely to appear in the assistant's own TTS.
// They can stop directly unless the current TTS text contains a stop word.
const STRONG_KEYWORDS = new Set([
  '赛维斯停止',
  '停一下',
  '停一停',
  '别说了',
  '不要说了',
]);
const WEAK_KEYWORDS = new Set(['停', '停下', '停啊', '停了', '停住']);
const HIT_COOLDOWN_MS = 800;

export type KeywordGateResult = 'none' | 'triggered' | 'rejected';

const firstExisting = (
  candidates: Array<string | undefined>,
): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const cwdCandidates = (relative: string): string[] => [
  path.resolve(process.cwd(), relative),
  path.resolve(app.getAppPath(), relative),
];

/**
 * Local stop-word detector + speaker gate.
 *
 * Wake-word models are intentionally trained to fire on short phrases. That is
 * exactly what we want for "停", but it also means the assistant can hear its
 * own TTS say "暂停". Running the detector on the raw microphone signal works
 * well during double-talk (verified against a real speaker recording); the
 * speaker embedding over the same ~1s window then rejects the assistant's own
 * voice. AEC is deliberately not in this path: WebRTC AEC3 suppressed the
 * near-end speaker and removed the "停一下" detection in the same sample.
 */
export class KeywordGate {
  private sherpa: SherpaModule | null = null;
  private spotter: InstanceType<SherpaModule['KeywordSpotter']> | null = null;
  private stream: ReturnType<
    InstanceType<SherpaModule['KeywordSpotter']>['createStream']
  > | null = null;
  private extractor: InstanceType<
    SherpaModule['SpeakerEmbeddingExtractor']
  > | null = null;
  private embedding: Float32Array | null = null;
  private threshold = DEFAULT_THRESHOLD;
  private cooldownMs = HIT_COOLDOWN_MS;
  private lastHitAt = 0;
  private warnedNoVoiceprint = false;
  private loaded = false;

  constructor(
    private readonly options: {
      onTrigger: (keyword: string) => void;
      onReject?: (keyword: string, score: number | null) => void;
      onDetected?: (keyword: string, at: number) => void;
      onVerified?: (
        keyword: string,
        score: number | null,
        accepted: boolean,
        at: number,
      ) => void;
    },
  ) {}

  get available(): boolean {
    return Boolean(this.spotter && this.stream);
  }

  load(): boolean {
    if (this.loaded) {
      return this.available;
    }
    this.loaded = true;

    const threshold = Number(process.env.CYRVIS_KWS_VOICEPRINT_THRESHOLD);
    if (Number.isFinite(threshold) && threshold > 0 && threshold < 1) {
      this.threshold = threshold;
    }
    const cooldown = Number(process.env.CYRVIS_KWS_COOLDOWN_MS);
    if (Number.isFinite(cooldown) && cooldown >= 0) {
      this.cooldownMs = cooldown;
    }

    try {
      this.sherpa = require('sherpa-onnx-node') as SherpaModule;
    } catch (error) {
      logger.error('[cyrvis kws] sherpa-onnx-node unavailable', error);
      return false;
    }

    const resourcesPath = process.resourcesPath || '';
    const packaged = (relative: string): string[] =>
      resourcesPath ? [path.resolve(resourcesPath, relative)] : [];
    const modelDir = firstExisting([
      process.env.CYRVIS_KWS_MODEL_DIR,
      ...cwdCandidates(`../../../models/kws/${KWS_DIR_NAME}`),
      ...cwdCandidates(`../../models/kws/${KWS_DIR_NAME}`),
      ...packaged(`models/kws/${KWS_DIR_NAME}`),
    ]);
    const keywordsFile = firstExisting([
      process.env.CYRVIS_KWS_KEYWORDS,
      ...cwdCandidates('resources/cyrvis/kws/keywords.txt'),
      ...cwdCandidates('../../resources/cyrvis/kws/keywords.txt'),
      ...packaged('cyrvis/kws/keywords.txt'),
    ]);

    if (!modelDir || !keywordsFile) {
      logger.warn('[cyrvis kws] disabled; model or keywords missing', {
        modelDir,
        keywordsFile,
      });
      return false;
    }

    const keywordsThreshold = Number(process.env.CYRVIS_KWS_THRESHOLD);
    try {
      this.spotter = new this.sherpa.KeywordSpotter({
        featConfig: {
          sampleRate: SAMPLE_RATE,
          featureDim: 80,
        },
        modelConfig: {
          transducer: {
            encoder: path.join(modelDir, KWS_ENCODER),
            decoder: path.join(modelDir, KWS_DECODER),
            joiner: path.join(modelDir, KWS_JOINER),
          },
          tokens: path.join(modelDir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        keywordsFile,
        keywordsScore: 1.0,
        // Very low threshold for short bare "停" recall. Self-echo safety now
        // comes from the TTS-text gate in feed(), not from KWS confidence.
        keywordsThreshold:
          Number.isFinite(keywordsThreshold) && keywordsThreshold > 0
            ? keywordsThreshold
            : 0.05,
        maxActivePaths: 4,
        numTrailingBlanks: 1,
      });
      this.stream = this.spotter.createStream();
      logger.info('[cyrvis kws] ready', { modelDir, keywordsFile });
    } catch (error) {
      logger.error('[cyrvis kws] model load failed', error);
      this.spotter = null;
      this.stream = null;
      return false;
    }

    const voiceprintModel = firstExisting([
      process.env.CYRVIS_VOICEPRINT_MODEL,
      ...cwdCandidates(`../../../models/voiceprint/${VOICEPRINT_MODEL}`),
      ...cwdCandidates(`../../models/voiceprint/${VOICEPRINT_MODEL}`),
      ...packaged(`models/voiceprint/${VOICEPRINT_MODEL}`),
    ]);
    const embeddingFile = firstExisting([
      process.env.CYRVIS_VOICEPRINT_EMBEDDING,
      ...cwdCandidates(`../../../models/voiceprint/${VOICEPRINT_EMBEDDING}`),
      ...cwdCandidates(`../../models/voiceprint/${VOICEPRINT_EMBEDDING}`),
      ...packaged(`models/voiceprint/${VOICEPRINT_EMBEDDING}`),
    ]);

    if (voiceprintModel && embeddingFile) {
      try {
        this.extractor = new this.sherpa.SpeakerEmbeddingExtractor({
          model: voiceprintModel,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        });
        const buffer = fs.readFileSync(embeddingFile);
        const values = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          Math.floor(buffer.byteLength / 4),
        );
        const embedding = new Float32Array(values.length);
        embedding.set(values);
        this.embedding = normalize(embedding);
        logger.info('[cyrvis kws] voiceprint ready', {
          model: voiceprintModel,
          embedding: embeddingFile,
          dim: this.extractor.dim,
          threshold: this.threshold,
        });
      } catch (error) {
        logger.warn('[cyrvis kws] voiceprint unavailable', error);
        this.extractor = null;
        this.embedding = null;
      }
    } else {
      logger.warn('[cyrvis kws] voiceprint files missing', {
        voiceprintModel,
        embeddingFile,
      });
    }

    return this.available;
  }

  reset(): void {
    if (!this.spotter || !this.stream) {
      return;
    }
    try {
      this.spotter.reset(this.stream);
    } catch (error) {
      logger.warn('[cyrvis kws] stream reset failed', error);
    }
  }

  feed(
    pcm16: Int16Array,
    recent: Int16Array[],
    speakerMode: boolean,
    options: {
      ttsContainsStop?: boolean;
      reference?: Float32Array | null;
    } = {},
  ): KeywordGateResult {
    if (!this.spotter || !this.stream || pcm16.length === 0) {
      return 'none';
    }

    const samples = new Float32Array(pcm16.length);
    for (let index = 0; index < pcm16.length; index += 1) {
      samples[index] = pcm16[index] / 0x8000;
    }

    let keyword: string | null = null;
    try {
      this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      while (this.spotter.isReady(this.stream)) {
        this.spotter.decode(this.stream);
        const result = this.spotter.getResult(this.stream);
        if (result.keyword) {
          keyword = result.keyword;
          this.spotter.reset(this.stream);
          break;
        }
      }
    } catch (error) {
      logger.warn('[cyrvis kws] decode failed', error);
      return 'none';
    }

    if (!keyword) {
      return 'none';
    }

    const now = Date.now();
    if (now - this.lastHitAt < this.cooldownMs) {
      return 'none';
    }
    this.lastHitAt = now;
    logger.info('[cyrvis kws] detected', {
      keyword,
      speakerMode,
      playing: true,
    });
    this.options.onDetected?.(keyword, now);

    const strong = STRONG_KEYWORDS.has(keyword);
    const ttsContainsStop = options.ttsContainsStop === true;

    // If the current assistant text does not contain a stop word, a KWS hit is
    // treated as a real user stop and fires immediately. This is what makes a
    // single "停" work on the first attempt. When the assistant itself is
    // saying "停/暂停/停止", we fall through to the speaker check to avoid
    // self-interruption.
    if (!ttsContainsStop) {
      logger.info('[cyrvis kws] stop keyword; direct barge', {
        keyword,
        strong,
      });
      this.options.onVerified?.(keyword, null, true, Date.now());
      this.options.onTrigger(keyword);
      return 'triggered';
    }

    const score = this.verify(recent);
    const relative = options.reference
      ? this.verifyRelative(recent, options.reference)
      : null;
    const relativeAccepted =
      relative !== null && relative.margin > 0.05 && relative.userScore > 0.04;
    const relativeAvailable = options.reference != null && relative !== null;

    if (score !== null) {
      const threshold = strong
        ? Math.min(this.threshold, 0.2)
        : this.thresholdFor(keyword, ttsContainsStop);
      // When a valid TTS reference exists, relative margin is the primary
      // decision. Absolute score is only a fallback for the first ~1s when no
      // reference is available yet.
      const accepted = relativeAvailable
        ? relativeAccepted
        : score >= threshold;
      logger.info('[cyrvis kws] voiceprint gate', {
        keyword,
        strong,
        speakerMode,
        ttsContainsStop,
        score: Number(score.toFixed(4)),
        threshold,
        relativeUser:
          relative === null ? null : Number(relative.userScore.toFixed(4)),
        relativeTts:
          relative === null ? null : Number(relative.referenceScore.toFixed(4)),
        relativeMargin:
          relative === null ? null : Number(relative.margin.toFixed(4)),
        accepted,
      });
      this.options.onVerified?.(keyword, score, accepted, Date.now());
      if (!accepted) {
        this.options.onReject?.(keyword, score);
        return 'rejected';
      }
    } else if (relativeAccepted) {
      logger.info('[cyrvis kws] relative voiceprint accepted', {
        keyword,
        strong,
        relativeUser: Number(relative.userScore.toFixed(4)),
        relativeTts: Number(relative.referenceScore.toFixed(4)),
        relativeMargin: Number(relative.margin.toFixed(4)),
      });
      this.options.onVerified?.(keyword, relative.userScore, true, Date.now());
    } else if (strong) {
      logger.warn(
        '[cyrvis kws] voiceprint unavailable; accepting strong keyword',
        { keyword },
      );
      this.options.onVerified?.(keyword, null, true, Date.now());
    } else if (speakerMode) {
      // Weak/short words stay behind the verifier in speaker mode: "停" is the
      // word most likely to occur inside the assistant's "暂停/停止".
      const allowUnverified =
        !WEAK_KEYWORDS.has(keyword) &&
        process.env.CYRVIS_KWS_ALLOW_UNVERIFIED_MULTI !== '0';
      if (!allowUnverified) {
        if (!this.warnedNoVoiceprint) {
          this.warnedNoVoiceprint = true;
          logger.warn(
            '[cyrvis kws] speaker mode requires voiceprint; keyword ignored',
          );
        }
        this.options.onReject?.(keyword, null);
        return 'rejected';
      }
      logger.warn(
        '[cyrvis kws] voiceprint unavailable; accepting multi-syllable keyword',
        { keyword },
      );
      this.options.onVerified?.(keyword, null, true, Date.now());
    } else {
      this.options.onVerified?.(keyword, null, true, Date.now());
    }

    this.options.onTrigger(keyword);
    return 'triggered';
  }

  /**
   * A lone "停" is short and often quieter, so it needs both a higher floor
   * and a separate energy fallback. Multi-syllable words carry much more
   * speaker information and can use a lower threshold.
   */
  private thresholdFor(keyword: string, ttsContainsStop = false): number {
    if (WEAK_KEYWORDS.has(keyword)) {
      // A short "停/停下/停住" only contains ~300ms of user voice inside a 1s
      // window, so its embedding is naturally weak. If the current TTS text
      // does not contain 停/暂停/停止, self-interruption is not a concern and
      // a much lower bar is safe.
      return ttsContainsStop ? 0.25 : 0.085;
    }
    return Math.min(this.threshold, 0.2);
  }

  /**
   * Speaker-verification score for the last ~1s of raw microphone audio.
   * Exposed so the energy fallback in voice-service can use the same verifier
   * when KWS misses a short bare "停".
   */
  verify(recent: Int16Array[]): number | null {
    if (!this.extractor || !this.embedding) {
      return null;
    }

    const chunks = recent.slice(-VERIFY_CHUNKS);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total < MIN_VERIFY_SAMPLES) {
      return null;
    }

    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index += 1) {
        samples[offset + index] = chunk[index] / 0x8000;
      }
      offset += chunk.length;
    }

    try {
      const stream = this.extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      stream.inputFinished();
      // Electron's V8 external ArrayBuffer handling rejects the default
      // external-buffer path with "External buffers are not allowed".
      // Copying inside the native extractor is slower but reliable.
      const embedding = normalize(this.extractor.compute(stream, false));
      let dot = 0;
      for (let index = 0; index < embedding.length; index += 1) {
        dot += embedding[index] * this.embedding[index];
      }
      return Math.max(-1, Math.min(1, dot));
    } catch (error) {
      logger.warn('[cyrvis kws] voiceprint compute failed', error);
      return null;
    }
  }

  /**
   * Compare the candidate against BOTH the enrolled user and the assistant's
   * current playback reference. A positive margin means the microphone window
   * is more likely the user than TTS echo, even when the absolute score is low.
   */
  verifyRelative(
    recent: Int16Array[],
    reference: Float32Array | null,
  ): { userScore: number; referenceScore: number; margin: number } | null {
    if (
      !this.extractor ||
      !this.embedding ||
      !reference ||
      reference.length < MIN_VERIFY_SAMPLES
    ) {
      return null;
    }

    const chunks = recent.slice(-VERIFY_CHUNKS);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total < MIN_VERIFY_SAMPLES) {
      return null;
    }
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index += 1) {
        samples[offset + index] = chunk[index] / 0x8000;
      }
      offset += chunk.length;
    }

    try {
      const candidateStream = this.extractor.createStream();
      candidateStream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      candidateStream.inputFinished();
      const candidate = normalize(
        this.extractor.compute(candidateStream, false),
      );

      let userScore = 0;
      for (let index = 0; index < candidate.length; index += 1) {
        userScore += candidate[index] * this.embedding[index];
      }

      const referenceStream = this.extractor.createStream();
      referenceStream.acceptWaveform({
        samples: reference,
        sampleRate: SAMPLE_RATE,
      });
      referenceStream.inputFinished();
      const referenceEmbedding = normalize(
        this.extractor.compute(referenceStream, false),
      );

      let referenceScore = 0;
      for (let index = 0; index < candidate.length; index += 1) {
        referenceScore += candidate[index] * referenceEmbedding[index];
      }

      return {
        userScore,
        referenceScore,
        margin: userScore - referenceScore,
      };
    } catch (error) {
      logger.warn('[cyrvis kws] relative voiceprint failed', error);
      return null;
    }
  }
}

const normalize = (input: Float32Array): Float32Array => {
  let energy = 0;
  for (let index = 0; index < input.length; index += 1) {
    energy += input[index] * input[index];
  }
  const norm = Math.sqrt(energy);
  if (norm > 1e-9) {
    for (let index = 0; index < input.length; index += 1) {
      input[index] /= norm;
    }
  }
  return input;
};
