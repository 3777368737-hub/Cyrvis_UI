import type { DesktopGaze } from './context';
import type { GazeSuggestion } from './suggestions';

export interface ProactiveGazeStatus {
  enabled: boolean;
  phase: 'off' | 'watching' | 'waiting' | 'inspecting' | 'cooldown' | 'error';
  dwellMs: number;
  progress: number;
  suggestion?: GazeSuggestion;
  error?: string;
}
interface Dependencies {
  inspect: () => Promise<GazeSuggestion | null>;
  cancel: () => void;
  canInspect: () => boolean;
  onSuggestion: (suggestion: GazeSuggestion) => void;
  now?: () => number;
}
const RADIUS = 0.085;
const MAX_GAP = 2200;
const distance = (a: DesktopGaze, b: DesktopGaze) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const sameTarget = (a: DesktopGaze, b: DesktopGaze) =>
  a.target || b.target
    ? a.target?.id === b.target?.id
    : distance(a, b) <= RADIUS;

/** Local dwell gating; no camera frames or periodic screenshots are uploaded. */
export class ProactiveGaze {
  private status: ProactiveGazeStatus = {
    enabled: false,
    phase: 'off',
    dwellMs: 4500,
    progress: 0,
  };
  private anchor: DesktopGaze | null = null;
  private latest: DesktopGaze | null = null;
  private startedAt = 0;
  private nextAt = 0;
  private generation = 0;
  private busy = false;
  private seenPositions: { gaze: DesktopGaze; at: number }[] = [];
  private seenTargets = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now || Date.now;
  }
  getStatus() {
    if (
      this.status.suggestion &&
      this.now() - this.status.suggestion.observedAt >= 120_000
    )
      this.status.suggestion = undefined;
    return { ...this.status };
  }
  configure(enabled: boolean, dwellMs = this.status.dwellMs) {
    const next = Math.max(
      3000,
      Math.min(12000, Number.isFinite(dwellMs) ? dwellMs : 4500),
    );
    this.invalidate();
    this.anchor = null;
    this.status = {
      enabled,
      dwellMs: next,
      phase: enabled ? 'watching' : 'off',
      progress: 0,
    };
    return this.getStatus();
  }
  snooze(ms = 60_000) {
    this.nextAt = this.now() + ms;
    this.invalidate();
    this.anchor = null;
    this.status = {
      ...this.status,
      phase: this.status.enabled ? 'cooldown' : 'off',
      progress: 0,
      suggestion: undefined,
    };
  }
  private invalidate() {
    this.generation++;
    this.deps.cancel();
  }
  update(sample: DesktopGaze | null): void {
    const previous = this.latest;
    this.latest = sample;
    if (!this.status.enabled) return;
    const now = this.now();
    if (!sample || now - sample.at > MAX_GAP) {
      this.invalidate();
      this.anchor = null;
      this.status.progress = 0;
      this.status.phase = 'watching';
      return;
    }
    if (
      !this.anchor ||
      !previous ||
      now - previous.at > MAX_GAP ||
      this.anchor.displayId !== sample.displayId ||
      !sameTarget(this.anchor, sample)
    ) {
      this.invalidate();
      this.anchor = { ...sample };
      this.startedAt = now;
      this.status.progress = 0;
    }
    if (this.busy) return;
    if (now < this.nextAt) {
      this.status.phase = 'cooldown';
      return;
    }
    if (!this.deps.canInspect()) {
      this.startedAt = now;
      this.status.progress = 0;
      this.status.phase = 'waiting';
      return;
    }
    this.seenPositions = this.seenPositions.filter(
      (item) => now - item.at < 180_000,
    );
    if (
      this.seenPositions.some(
        (item) =>
          item.gaze.displayId === sample.displayId &&
          sameTarget(item.gaze, sample),
      )
    ) {
      this.status.phase = 'cooldown';
      return;
    }
    this.status.phase = 'watching';
    this.status.progress = Math.min(
      1,
      (now - this.startedAt) / this.status.dwellMs,
    );
    if (this.status.progress < 1) return;
    const generation = this.generation;
    const frozen = { ...sample, bounds: { ...sample.bounds } };
    this.busy = true;
    this.status = { ...this.status, phase: 'inspecting', error: undefined };
    this.nextAt = now + 60_000;
    void this.deps
      .inspect()
      .then((suggestion) => {
        if (
          generation !== this.generation ||
          !this.status.enabled ||
          !this.latest ||
          this.now() - this.latest.at > MAX_GAP ||
          this.latest.displayId !== frozen.displayId ||
          !sameTarget(this.latest, frozen) ||
          !this.deps.canInspect()
        )
          return;
        this.seenPositions.push({ gaze: frozen, at: this.now() });
        if (!suggestion) return;
        const key =
          `${suggestion.kind}:${suggestion.target || suggestion.description}`
            .toLowerCase()
            .replace(/\s/g, '');
        if (this.now() - (this.seenTargets.get(key) ?? -Infinity) < 300_000)
          return;
        this.seenTargets.set(key, this.now());
        if (this.seenTargets.size > 100)
          this.seenTargets.delete(this.seenTargets.keys().next().value!);
        suggestion = { ...suggestion, gaze: frozen };
        this.status.suggestion = suggestion;
        this.deps.onSuggestion(suggestion);
      })
      .catch((error) => {
        if (generation === this.generation && this.status.enabled)
          this.status = {
            ...this.status,
            phase: 'error',
            error: error instanceof Error ? error.message : '主动识别失败',
          };
      })
      .finally(() => {
        this.busy = false;
        if (this.status.enabled && this.status.phase === 'inspecting')
          this.status.phase = 'cooldown';
        this.status.progress = 0;
      });
  }
}
