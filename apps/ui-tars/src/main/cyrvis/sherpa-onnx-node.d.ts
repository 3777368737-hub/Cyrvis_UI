declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OnlineStream {
    acceptWaveform(waveform: Waveform): void;
    inputFinished(): void;
  }

  export interface KeywordResult {
    keyword?: string;
    start_time?: number;
    timestamps?: number[];
    tokens?: string[];
  }

  export class KeywordSpotter {
    constructor(config: Record<string, unknown>);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: Record<string, unknown>);
    readonly dim: number;
    createStream(): OnlineStream;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }

  export function readWave(path: string): Waveform;
}
