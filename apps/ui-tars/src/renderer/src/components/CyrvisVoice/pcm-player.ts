const SAMPLE_RATE = 24000;
const START_BUFFER_SECONDS = 0.12;

/** macOS playback uses one audio clock, not a succession of media files.
 * Capture remains in the separate hidden renderer. Windows keeps the WAV
 * player because of its platform-specific Chromium capture suppression.
 */
export class PcmStreamPlayer {
  private context: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: Int16Array[] = [];
  private nextTime = 0;
  private finished = false;
  private stopped = false;
  private idleEmitted = false;
  private preparing: Promise<void> | null = null;

  constructor(
    private onIdle: () => void,
    private onError: (error: unknown) => void,
  ) {
    this.context = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: 'interactive',
    });
  }

  get isActive(): boolean {
    return this.pending.length > 0 || this.sources.size > 0;
  }

  play(samples: Int16Array): void {
    if (this.finished || this.stopped || !samples.length) return;
    this.pending.push(samples.slice());
    this.pump();
  }

  finish(): void {
    if (this.stopped) return;
    this.finished = true;
    this.pump();
  }

  /** Intentional cancellation is handled by the caller; it is not a drain. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = [];
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* A failed start has no running source. */
      }
      source.disconnect();
    }
    this.sources.clear();
    void this.context.close().catch(() => undefined);
  }

  async setSinkId(deviceId: string): Promise<void> {
    if (this.stopped) return;
    const context = this.context as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (!context.setSinkId) {
      if (deviceId !== 'default')
        throw new Error('Output selection is unavailable');
      return;
    }
    await this.prepare(
      (this.preparing ?? Promise.resolve()).then(() => {
        if (!this.stopped)
          return context.setSinkId!(deviceId === 'default' ? '' : deviceId);
        return undefined;
      }),
    );
  }

  private prepare(promise: Promise<void>): Promise<void> {
    this.preparing = promise;
    return promise
      .then(() => {
        if (this.preparing !== promise || this.stopped) return;
        this.preparing = null;
        this.pump();
      })
      .catch((error) => this.fail(error));
  }

  private pump(): void {
    if (this.preparing || this.stopped) return;
    if (this.context.state === 'suspended') {
      void this.prepare(this.context.resume());
      return;
    }
    try {
      for (const samples of this.pending.splice(0)) {
        const buffer = this.context.createBuffer(
          1,
          samples.length,
          SAMPLE_RATE,
        );
        const data = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        source.onended = () => {
          source.disconnect();
          this.sources.delete(source);
          this.maybeIdle();
        };
        this.sources.add(source);
        // Preserve all queued audio. Only rebase after an actual underrun.
        if (this.nextTime <= this.context.currentTime)
          this.nextTime = this.context.currentTime + START_BUFFER_SECONDS;
        source.start(this.nextTime);
        this.nextTime += buffer.duration;
      }
      this.maybeIdle();
    } catch (error) {
      this.fail(error);
    }
  }

  private maybeIdle(): void {
    if (this.finished && !this.isActive && !this.stopped) {
      this.stop();
      this.emitIdle();
    }
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.onError(error);
    this.emitIdle();
  }
  private emitIdle(): void {
    if (this.idleEmitted) return;
    this.idleEmitted = true;
    this.onIdle();
  }
}
