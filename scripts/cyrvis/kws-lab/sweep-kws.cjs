#!/usr/bin/env node
/*
 * Offline KWS parameter sweep for CYRVIS.
 *
 * Run from the repo root:
 *   node scripts/cyrvis/kws-lab/sweep-kws.cjs
 *   node scripts/cyrvis/kws-lab/sweep-kws.cjs --files doc/kws-lab/failed-*.wav
 *
 * It uses the same sherpa-onnx-node binding as the Electron app, so the
 * detection timings are directly comparable. Results are written to
 * doc/kws-lab/sweep-results.json.
 */
const fs = require('node:fs');
const path = require('node:path');

const sherpa = require('sherpa-onnx-node');

const repoRoot = path.resolve(__dirname, '../../..');
const cyrvisRoot = path.resolve(repoRoot, '..');
const modelDir = path.join(
  cyrvisRoot,
  'models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
);
const keywordsFile = path.join(
  repoRoot,
  'apps/ui-tars/resources/cyrvis/kws/keywords.txt',
);
const voiceprintModel = path.join(
  cyrvisRoot,
  'models/voiceprint/3dspeaker_eres2net_base.onnx',
);
const voiceprintEmbedding = path.join(
  cyrvisRoot,
  'models/voiceprint/user_embedding.f32',
);
const defaultFiles = [
  path.join(cyrvisRoot, 'models/voiceprint/doubletalk.wav'),
  path.join(
    repoRoot,
    'apps/ui-tars/src/main/cyrvis/__fixtures__/tts-pause-16k.wav',
  ),
  path.join(
    repoRoot,
    'apps/ui-tars/src/main/cyrvis/__fixtures__/tts-bieshuole-16k.wav',
  ),
];
const outDir = path.join(repoRoot, 'doc/kws-lab');
const outFile = path.join(outDir, 'sweep-results.json');

const args = process.argv.slice(2);
const fileArgs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--files') {
    while (args[i + 1] && !args[i + 1].startsWith('--')) {
      fileArgs.push(path.resolve(args[i + 1]));
      i += 1;
    }
  }
}
const files = (fileArgs.length ? fileArgs : defaultFiles).filter((file) =>
  fs.existsSync(file),
);
if (!files.length) {
  console.error('no WAV files found');
  process.exit(1);
}
if (!fs.existsSync(modelDir) || !fs.existsSync(keywordsFile)) {
  console.error('KWS model or keywords missing', { modelDir, keywordsFile });
  process.exit(1);
}

const thresholds = [0.05, 0.1, 0.15, 0.2];
const scores = [1.0];
const trailingBlanks = [0, 1, 2];

const loadVoiceprint = () => {
  if (
    !fs.existsSync(voiceprintModel) ||
    !fs.existsSync(voiceprintEmbedding)
  ) {
    return null;
  }
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: voiceprintModel,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  });
  const buffer = fs.readFileSync(voiceprintEmbedding);
  const saved = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4),
  );
  let norm = 0;
  for (const value of saved) norm += value * value;
  norm = Math.sqrt(norm);
  for (let i = 0; i < saved.length; i += 1) saved[i] /= norm;
  return { extractor, saved };
};

const scoreAt = (voiceprint, samples, at) => {
  if (!voiceprint) return null;
  const start = Math.max(0, Math.floor((at - 1.0) * 16000));
  const end = Math.min(samples.length, Math.floor((at + 0.1) * 16000));
  if (end - start < 8000) return null;
  const stream = voiceprint.extractor.createStream();
  stream.acceptWaveform({
    samples: samples.subarray(start, end),
    sampleRate: 16000,
  });
  stream.inputFinished();
  const embedding = voiceprint.extractor.compute(stream, false);
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    dot += embedding[i] * voiceprint.saved[i];
    energy += embedding[i] * embedding[i];
  }
  return dot / Math.sqrt(energy || 1);
};

const runOne = (wav, config) => {
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(
          modelDir,
          'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        ),
        decoder: path.join(
          modelDir,
          'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        ),
        joiner: path.join(
          modelDir,
          'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        ),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile,
    keywordsScore: config.score,
    keywordsThreshold: config.threshold,
    maxActivePaths: 4,
    numTrailingBlanks: config.trailingBlanks,
  });
  const stream = spotter.createStream();
  const hits = [];
  const chunk = 1600;
  const { samples, sampleRate } = wav;
  for (let offset = 0; offset < samples.length; offset += chunk) {
    stream.acceptWaveform({
      samples: samples.subarray(
        offset,
        Math.min(offset + chunk, samples.length),
      ),
      sampleRate,
    });
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      const result = spotter.getResult(stream);
      if (result.keyword) {
        const at = (offset + chunk) / sampleRate;
        hits.push({ at: Number(at.toFixed(2)), keyword: result.keyword });
        spotter.reset(stream);
      }
    }
  }
  return hits;
};

fs.mkdirSync(outDir, { recursive: true });
const voiceprint = loadVoiceprint();
const filesData = files.map((file) => {
  const wav = sherpa.readWave(file);
  return {
    file: path.relative(repoRoot, file),
    samples: wav.samples,
    sampleRate: wav.sampleRate,
    duration: Number((wav.samples.length / wav.sampleRate).toFixed(2)),
  };
});

const results = [];
for (const file of filesData) {
  for (const threshold of thresholds) {
    for (const score of scores) {
      for (const blanks of trailingBlanks) {
        const config = { threshold, score, trailingBlanks: blanks };
        const hits = runOne(file, config);
        results.push({
          file: file.file,
          duration: file.duration,
          threshold,
          score,
          trailingBlanks: blanks,
          hits: hits.map((hit) => {
            const value = scoreAt(voiceprint, file.samples, hit.at);
            return {
              ...hit,
              voiceprint: value === null ? null : Number(value.toFixed(4)),
            };
          }),
        });
      }
    }
  }
}

fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log('wrote', outFile);
for (const file of filesData) {
  console.log('\n==', file.file, `${file.duration}s ==`);
  const rows = results.filter((item) => item.file === file.file);
  for (const row of rows) {
    const hits = row.hits
      .map((hit) => `${hit.at}s:${hit.keyword}:${hit.voiceprint ?? '-'}`)
      .join(', ');
    console.log(
      `th=${row.threshold} score=${row.score} blanks=${row.trailingBlanks} -> ${
        hits || 'none'
      }`,
    );
  }
}
