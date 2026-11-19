import type { DesktopGaze } from './context';
import type { GazeSuggestion } from './suggestions';

export interface ProactiveGazeStatus {
  enabled: boolean;
  phase: 'off' | 'watching' | 'waiting' | 'inspecting' | 'cooldown' | 'error';
  dwellMs: number;
  progress: number;
  suggestion?: GazeSuggestion;
  error?: string;
  detail?: string;
  retryAt?: number;
}
interface Dependencies {
  inspect: () => Promise<GazeSuggestion | null>;
  cancel: () => void;
  canInspect: () => boolean;
  onSuggestion: (suggestion: GazeSuggestion) => void;
  now?: () => number;
  onEvent?: (event: string, detail?: string) => void;
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
  private pending: {
    suggestion: GazeSuggestion;
    gaze: DesktopGaze;
    generation: number;
    expiresAt: number;
  } | null = null;
  private deliveryTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.invalidate(enabled ? '重新设置主动提醒' : '关闭主动提醒');
    this.anchor = null;
    this.nextAt = 0;
    this.seenPositions = [];
    this.seenTargets.clear();
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
    this.invalidate('用户主动提问或暂缓提醒');
    this.anchor = null;
    this.status = {
      ...this.status,
      phase: this.status.enabled ? 'cooldown' : 'off',
      progress: 0,
      suggestion: undefined,
      detail: '已暂缓主动提醒。',
      retryAt: this.nextAt,
    };
  }
  private invalidate(reason: string) {
    if (this.busy || this.pending) this.deps.onEvent?.('cancelled', reason);
    this.generation++;
    this.pending = null;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = null;
    this.deps.cancel();
  }
  resetObservation() {
    this.invalidate('显示器状态变化');
    this.anchor = null;
    this.latest = null;
    this.status.progress = 0;
  }
  update(sample: DesktopGaze | null): void {
    const previous = this.latest;
    this.latest = sample;
    if (!this.status.enabled) return;
    const now = this.now();
    // Dwell authorizes one frozen screenshot. Normal gaze movement, blinks or
    // local object-ID jitter after capture must not abort that read-only call.
    if (this.busy || this.pending) return;
    if (!sample || now - sample.at > MAX_GAP) {
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
      this.anchor = { ...sample };
      this.startedAt = now;
      this.status.progress = 0;
    }
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
    this.status = {
      ...this.status,
      phase: 'inspecting',
      error: undefined,
      detail: undefined,
      retryAt: undefined,
    };
    // Back off briefly while a request is pending. The full reminder cooldown
    // and seen-object cache apply only to a result actually announced.
    this.nextAt = now + 20_000;
    this.deps.onEvent?.('trigger');
    void this.deps
      .inspect()
      .then((suggestion) => {
        if (
          generation !== this.generation ||
          !this.status.enabled ||
          (this.latest && this.latest.displayId !== frozen.displayId)
        ) {
          this.deps.onEvent?.(
            'discarded',
            '已关闭主动提醒或屏幕已改变，未播报',
          );
          return;
        }
        if (!suggestion) {
          this.nextAt = this.now() + 20_000;
          this.status.detail = '画面为空或目标不明确，尚未播报；稍后重试。';
          this.status.retryAt = this.nextAt;
          this.deps.onEvent?.('uncertain', this.status.detail);
          return;
        }
        this.pending = {
          suggestion,
          gaze: frozen,
          generation,
          expiresAt: Math.min(frozen.at + 60_000, this.now() + 25_000),
        };
        this.deliver();
      })
      .catch((error) => {
        if (generation === this.generation && this.status.enabled) {
          this.nextAt = this.now() + 20_000;
          this.status = {
            ...this.status,
            phase: 'error',
            error: error instanceof Error ? error.message : '主动识别失败',
            detail: '本次识别失败，尚未播报；稍后重试。',
            retryAt: this.nextAt,
          };
        }
        this.deps.onEvent?.(
          'failed',
          error instanceof Error ? error.message : '主动识别失败',
        );
      })
      .finally(() => {
        this.busy = false;
        if (this.status.enabled && this.status.phase === 'inspecting')
          this.status.phase = 'cooldown';
        this.status.progress = 0;
      });
  }
  private deliver(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.generation !== this.generation || !this.status.enabled) {
      this.pending = null;
      return;
    }
    if (this.now() >= pending.expiresAt) {
      this.pending = null;
      this.status.phase = 'cooldown';
      this.status.detail = '语音持续繁忙，刚才的识别结果已过期，未播报。';
      this.deps.onEvent?.('discarded', this.status.detail);
      return;
    }
    if (!this.deps.canInspect()) {
      this.status.phase = 'waiting';
      this.status.detail = '截图已识别完成，等待语音连接或空闲后播报。';
      this.deliveryTimer = setTimeout(() => {
        this.deliveryTimer = null;
        this.deliver();
      }, 250);
      return;
    }
    const { suggestion, gaze } = pending;
    this.pending = null;
    const key =
      `${suggestion.kind}:${suggestion.target || suggestion.candidate || suggestion.description}`
        .toLowerCase()
        .replace(/\s/g, '');
    if (this.now() - (this.seenTargets.get(key) ?? -Infinity) < 300_000) {
      this.seenPositions.push({ gaze, at: this.now() });
      this.status.phase = 'cooldown';
      this.status.detail = '这个对象已提醒过，暂不重复。';
      return;
    }
    const spoken = {
      ...suggestion,
      gaze,
      speech: `刚才你注视的区域里：${suggestion.speech}`,
    };
    this.deps.onSuggestion(spoken);
    this.seenPositions.push({ gaze, at: this.now() });
    this.seenTargets.set(key, this.now());
    if (this.seenTargets.size > 100)
      this.seenTargets.delete(this.seenTargets.keys().next().value!);
    this.nextAt = this.now() + 60_000;
    this.status.phase = 'cooldown';
    this.status.suggestion = spoken;
    this.status.detail = '已生成描述并交给语音助手播报。';
    this.status.retryAt = this.nextAt;
    this.deps.onEvent?.('announced');
  }
}
