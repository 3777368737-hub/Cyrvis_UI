import WebSocket, { type RawData } from 'ws';

import { logger } from '@main/logger';

const SAMPLE_RATE = 16000;
const START_TIMEOUT_MS = 8000;
const FINISH_TIMEOUT_MS = 15000;
const APPEND_SAMPLES = 8000; // 0.5s per frame

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const eventId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const realtimeUrl = () => {
  const configured =
    process.env.QWEN_REALTIME_URL ||
    'wss://token-plan.maas.qianwenaiapi.com/api-ws/v1/realtime';
  if (/[?&]model=/.test(configured)) {
    return configured;
  }
  return `${configured}${configured.includes('?') ? '&' : '?'}model=qwen-audio-3.0-realtime-plus`;
};

const apiKey = () => (process.env.QWEN_API_KEY || '').trim();

const toPcmBuffer = (chunks: Int16Array[]): Buffer => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = Buffer.alloc(total * 2);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      buffer.writeInt16LE(chunk[index], offset);
      offset += 2;
    }
  }
  return buffer;
};

/**
 * Uses the realtime-plus model as an ASR-only bridge for the cascade voice
 * chain. The session is text-only, has no turn detection, and never sends
 * response.create, so the model transcribes the utterance without generating
 * an assistant reply.
 */
export const transcribeRealtime = async (
  chunks: Int16Array[],
): Promise<string> => {
  const key = apiKey();
  if (!key) {
    throw new Error('QWEN_API_KEY is required for the realtime ASR bridge');
  }
  const pcm = toPcmBuffer(chunks);
  if (!pcm.length) {
    return '';
  }

  const socket = new WebSocket(realtimeUrl(), {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: START_TIMEOUT_MS,
    perMessageDeflate: false,
  });
  const ready = deferred<void>();
  const finished = deferred<string>();
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      socket.close();
    } catch {
      // already closed
    }
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }
    let event: {
      type?: string;
      error?: { message?: string; code?: string };
      transcript?: string;
    };
    try {
      event = JSON.parse(data.toString()) as typeof event;
    } catch {
      return;
    }
    if (event.type === 'session.created') {
      socket.send(
        JSON.stringify({
          event_id: eventId('event_session'),
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: 'Only transcribe the user audio. Do not answer.',
            input_audio_transcription: {
              model: 'qwen3-asr-flash-realtime',
            },
            turn_detection: null,
            audio: {
              input: { format: { type: 'pcm', sample_rate: SAMPLE_RATE } },
              output: { format: { type: 'pcm', sample_rate: 24000 } },
            },
          },
        }),
      );
      return;
    }
    if (event.type === 'session.updated') {
      ready.resolve();
      return;
    }
    if (
      event.type === 'conversation.item.input_audio_transcription.completed'
    ) {
      finished.resolve(event.transcript || '');
      return;
    }
    if (event.type === 'error') {
      const message =
        event.error?.message || event.error?.code || 'realtime ASR error';
      ready.reject(new Error(message));
      finished.reject(new Error(message));
    }
  });
  socket.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    ready.reject(new Error(message));
    finished.reject(new Error(message));
  });
  socket.on('close', () => {
    if (!disposed) {
      const error = new Error('Realtime ASR connection closed');
      ready.reject(error);
      finished.reject(error);
    }
  });

  try {
    await Promise.race([
      ready.promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Realtime ASR session startup timed out')),
          START_TIMEOUT_MS,
        ),
      ),
    ]);
    for (let offset = 0; offset < pcm.length; offset += APPEND_SAMPLES * 2) {
      const frame = pcm.subarray(
        offset,
        Math.min(pcm.length, offset + APPEND_SAMPLES * 2),
      );
      socket.send(
        JSON.stringify({
          event_id: eventId('event_append'),
          type: 'input_audio_buffer.append',
          audio: frame.toString('base64'),
        }),
      );
      // Let the socket breathe between 0.5s frames.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    socket.send(
      JSON.stringify({
        event_id: eventId('event_commit'),
        type: 'input_audio_buffer.commit',
      }),
    );
    const text = await Promise.race([
      finished.promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Realtime ASR transcription timed out')),
          FINISH_TIMEOUT_MS,
        ),
      ),
    ]);
    logger.info('[cyrvis realtime asr] transcribed', {
      samples: pcm.length / 2,
      chars: text.length,
    });
    return text.trim();
  } finally {
    dispose();
  }
};
