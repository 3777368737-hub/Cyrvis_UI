import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { BrowserWindow } from 'electron';

import { logger } from '@main/logger';

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 24000;
const CHUNK_SAMPLES = 4800; // 200ms

interface LocalTtsSession {
  id: string;
  text: string;
  cancelled: boolean;
}

const sessions = new Map<string, LocalTtsSession>();

const emit = (event: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('qwen-tts:stream', event);
    }
  }
};

const readWavPcm16 = (file: string): Buffer => {
  const buffer = fs.readFileSync(file);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (
    dataStart < 0 ||
    sampleRate !== SAMPLE_RATE ||
    channels < 1 ||
    bits !== 16
  ) {
    throw new Error(
      `Unexpected SAPI WAV: sr=${sampleRate} ch=${channels} bits=${bits}`,
    );
  }
  const source = buffer.subarray(dataStart, dataStart + dataLength);
  if (channels === 1) {
    return source;
  }
  const frames = Math.floor(source.length / (channels * 2));
  const mono = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += source.readInt16LE((frame * channels + channel) * 2);
    }
    mono.writeInt16LE(Math.round(sum / channels), frame * 2);
  }
  return mono;
};

const synthesize = async (text: string): Promise<Buffer> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrvis-tts-'));
  const wavFile = path.join(dir, 'speech.wav');
  const textFile = path.join(dir, 'text.txt');
  fs.writeFileSync(textFile, text, 'utf8');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}",
    '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${wavFile.replace(/'/g, "''")}', $format)`,
    `$text = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
    '$s.Speak($text)',
    '$s.Dispose()',
  ].join('; ');
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    return readWavPcm16(wavFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Windows SAPI fallback used only for end-to-end barge experiments when the
 * configured cloud TTS cannot clone a voice. It implements the same
 * `qwen-tts:*` session protocol the renderer's streaming player consumes.
 */
export const localTtsService = {
  start(_input?: { requestId?: string }) {
    const session: LocalTtsSession = {
      id: randomUUID(),
      text: '',
      cancelled: false,
    };
    sessions.set(session.id, session);
    logger.info('[cyrvis local tts] session started', {
      sessionId: session.id,
    });
    return {
      sessionId: session.id,
      voice: 'sapi-huihui',
      sampleRate: SAMPLE_RATE,
      format: 'pcm' as const,
      protocol: 'qwen-audio-tts' as const,
    };
  },

  append(input: { sessionId: string; text: string }) {
    const session = sessions.get(input.sessionId);
    if (!session || session.cancelled) {
      return { ok: false };
    }
    session.text += input.text || '';
    return { ok: true };
  },

  finish(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false };
    }
    const text = session.text.trim();
    void (async () => {
      try {
        if (!text) {
          emit({ type: 'completed', sessionId });
          return;
        }
        logger.info('[cyrvis local tts] synthesizing', {
          sessionId,
          chars: text.length,
        });
        const pcm = await synthesize(text);
        if (session.cancelled) {
          return;
        }
        for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES * 2) {
          if (session.cancelled) {
            return;
          }
          const chunk = pcm.subarray(
            offset,
            Math.min(pcm.length, offset + CHUNK_SAMPLES * 2),
          );
          emit({
            type: 'audio',
            sessionId,
            delta: chunk.toString('base64'),
            sampleRate: SAMPLE_RATE,
          });
        }
        emit({ type: 'completed', sessionId });
        logger.info('[cyrvis local tts] completed', { sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[cyrvis local tts] failed', { sessionId, message });
        emit({ type: 'error', sessionId, error: message });
      }
    })();
    return { ok: true };
  },

  cancel(sessionId: string) {
    const session = sessions.get(sessionId);
    if (session) {
      session.cancelled = true;
      sessions.delete(sessionId);
    }
    return { ok: true };
  },

  ensureVoice() {
    return { voice: 'sapi-huihui', created: false, model: 'sapi' };
  },
};
