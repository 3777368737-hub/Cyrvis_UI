// WAV segments are used because the plain-WAV probe kept the microphone
// alive on Windows, while Web Audio and MediaSource playback silenced it.

const SAMPLE_RATE = 24000;
// ~0.75s per segment: long enough to keep gaps rare, short enough that the
// first reply starts promptly.
const SEGMENT_SAMPLES = 18000;

interface QueuedSegment {
  blob: Blob;
  pcm16: Int16Array;
}

/**
 * Streams 24 kHz PCM16 chunks as independent WAV files played by plain
 * <audio> elements.
 *
 * Why not Web Audio or MediaSource: on Windows, Chrome/Electron treats both
 * AudioContext playback and MediaSource audio as an echo-cancellation
 * reference and drives the microphone to digital silence while the assistant
 * speaks. A plain media file (blob URL) does not, so this keeps the
 * microphone usable for barge-in.
 */
export class WavStreamPlayer {
  private readonly onIdle: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly onSegmentStart?: (pcm16: Int16Array) => void;
  private samples: number[] = [];
  private queue: QueuedSegment[] = [];
  private current: HTMLAudioElement | null = null;
  private currentPcm16: Int16Array | null = null;
  private currentUrl: string | null = null;
  private outputDeviceId: string | null = null;
  private finished = false;
  private idleEmitted = false;
  private paused = false;

  constructor(
    onIdle: () => void,
    onError: (error: unknown) => void,
    onSegmentStart?: (pcm16: Int16Array) => void,
  ) {
    this.onIdle = onIdle;
    this.onError = onError;
    this.onSegmentStart = onSegmentStart;
  }

  get isActive(): boolean {
    return (
      this.current !== null || this.queue.length > 0 || this.samples.length > 0
    );
  }

  play(pcm16: Int16Array): void {
    if (this.finished || !pcm16.length) {
      return;
    }
    for (let i = 0; i < pcm16.length; i += 1) {
      this.samples.push(pcm16[i]);
    }
    while (this.samples.length >= SEGMENT_SAMPLES) {
      this.flushSegment(SEGMENT_SAMPLES);
    }
    this.playNext();
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.samples.length) {
      this.flushSegment(this.samples.length);
    }
    this.playNext();
    this.maybeIdle();
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.current?.pause();
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    const audio = this.current;
    if (audio) {
      void this.startAudio(audio, true).catch((error) => {
        if (this.finished || this.current !== audio) {
          return;
        }
        this.onError(error);
        this.stopCurrent();
        this.playNext();
      });
      return;
    }
    this.playNext();
  }

  stop(notifyIdle = true): void {
    const wasActive = this.isActive;
    this.finished = true;
    this.paused = false;
    this.samples = [];
    this.queue = [];
    this.stopCurrent();
    if (wasActive && notifyIdle) {
      this.emitIdle();
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    const audio = this.current;
    if (!audio) {
      return;
    }
    const sinkable = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (sinkable.setSinkId) {
      await sinkable.setSinkId(deviceId);
    }
    if (!this.paused && this.currentPcm16) {
      const offset = Math.min(
        this.currentPcm16.length,
        Math.max(0, Math.floor(audio.currentTime * SAMPLE_RATE)),
      );
      this.onSegmentStart?.(this.currentPcm16.subarray(offset));
    }
  }

  private flushSegment(count: number): void {
    const pcm = Int16Array.from(this.samples.splice(0, count));
    if (!pcm.length) {
      return;
    }
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i += 1) {
      view.setInt16(44 + i * 2, pcm[i], true);
    }
    this.queue.push({
      blob: new Blob([buffer], { type: 'audio/wav' }),
      pcm16: pcm.slice(),
    });
  }

  private playNext(): void {
    if (this.paused || this.current || this.queue.length === 0) {
      this.maybeIdle();
      return;
    }
    const segment = this.queue.shift();
    if (!segment) {
      return;
    }
    const url = URL.createObjectURL(segment.blob);
    const audio = document.createElement('audio');
    audio.src = url;
    audio.autoplay = true;
    audio.style.display = 'none';
    this.current = audio;
    this.currentPcm16 = segment.pcm16;
    this.currentUrl = url;
    document.body.appendChild(audio);

    audio.addEventListener(
      'ended',
      () => {
        this.stopCurrent();
        this.playNext();
      },
      { once: true },
    );

    void this.startAudio(audio, false).catch((error) => {
      // A stop/next-response can revoke the URL while play() is pending;
      // that rejection is expected, not an audio failure.
      if (this.finished || this.current !== audio) {
        return;
      }
      this.onError(error);
      this.stopCurrent();
      this.playNext();
    });
  }

  private async startAudio(
    audio: HTMLAudioElement,
    resumed = false,
  ): Promise<void> {
    const sinkable = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (!this.paused) {
      // Apply the chosen output before playback, otherwise the first word can
      // leak to the previous/default device.
      if (this.outputDeviceId && sinkable.setSinkId) {
        await sinkable.setSinkId(this.outputDeviceId);
      }
      const activeSink = (audio as HTMLAudioElement & { sinkId?: string })
        .sinkId;
      console.log(
        '[cyrvis] player sink',
        this.outputDeviceId?.slice(0, 8) ?? 'default',
        activeSink?.slice(0, 8) ?? 'unknown',
      );
      // Publish the reference before awaiting play(). The play() promise can
      // resolve long after the media starts, which previously produced tiny
      // or missing reference segments and made the echo detector fail closed.
      // A real pause/resume sends the remaining tail instead.
      if (this.currentPcm16) {
        const offset = resumed
          ? Math.min(
              this.currentPcm16.length,
              Math.max(0, Math.floor(audio.currentTime * SAMPLE_RATE)),
            )
          : 0;
        this.onSegmentStart?.(this.currentPcm16.subarray(offset));
      }
      await audio.play();
    }
  }

  private stopCurrent(): void {
    const audio = this.current;
    this.current = null;
    this.currentPcm16 = null;
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (audio) {
      try {
        audio.pause();
        audio.src = '';
        audio.remove();
      } catch {
        // already detached
      }
    }
  }

  private maybeIdle(): void {
    if (
      this.finished &&
      this.current === null &&
      this.queue.length === 0 &&
      this.samples.length === 0
    ) {
      this.emitIdle();
    }
  }

  private emitIdle(): void {
    if (this.idleEmitted) {
      return;
    }
    this.idleEmitted = true;
    this.onIdle();
  }
}
