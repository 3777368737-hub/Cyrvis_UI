import type { DesktopGaze } from './context';

export interface ObjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface GazeObject {
  id: string;
  scene: string;
  label: string;
  role: string;
  source: 'accessibility' | 'vision' | 'text';
  bounds: ObjectBounds;
}
export interface ObjectFixation {
  phase: 'searching' | 'ambiguous' | 'candidate' | 'locked';
  target?: GazeObject;
  progress: number;
  since?: number;
}
export const OBJECT_TTL = 1800;
export function distanceToObject(x: number, y: number, b: ObjectBounds) {
  return Math.hypot(
    Math.max(b.x - x, 0, x - b.x - b.width),
    Math.max(b.y - y, 0, y - b.y - b.height),
  );
}
const sameGeometry = (a: ObjectBounds, b: ObjectBounds) =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  ) <= 8;

/** Selects actual objects, with a dead band and sustained evidence to switch. */
export class ObjectMagnet {
  private objects: GazeObject[] = [];
  private capturedAt = -Infinity;
  private scene = '';
  private locked: GazeObject | undefined;
  private pending: GazeObject | undefined;
  private pendingAt = 0;
  private lockedAt = 0;
  private outsideAt: number | null = null;
  reset() {
    this.objects = [];
    this.capturedAt = -Infinity;
    this.scene = '';
    this.locked = undefined;
    this.pending = undefined;
    this.outsideAt = null;
  }
  refresh(objects: GazeObject[], scene: string, at: number) {
    this.objects = objects.filter(
      (o) =>
        o.scene === scene &&
        [o.bounds.x, o.bounds.y, o.bounds.width, o.bounds.height].every(
          Number.isFinite,
        ) &&
        o.bounds.width >= 12 &&
        o.bounds.height >= 12,
    );
    this.capturedAt = at;
    const replacement = this.objects.find((o) => o.id === this.locked?.id);
    if (
      this.scene !== scene ||
      (this.locked &&
        (!replacement || !sameGeometry(this.locked.bounds, replacement.bounds)))
    ) {
      this.locked = undefined;
      this.pending = undefined;
      this.outsideAt = null;
    } else if (this.locked) this.locked = replacement;
    if (
      this.pending &&
      !this.objects.some(
        (o) =>
          o.id === this.pending!.id &&
          sameGeometry(o.bounds, this.pending!.bounds),
      )
    )
      this.pending = undefined;
    this.scene = scene;
  }
  update(gaze: DesktopGaze | null, now: number): ObjectFixation {
    if (!gaze || now - gaze.at > 800 || now - this.capturedAt > OBJECT_TTL) {
      this.locked = undefined;
      this.pending = undefined;
      this.outsideAt = null;
      return { phase: 'searching', progress: 0 };
    }
    const x = gaze.bounds.x + gaze.x * gaze.bounds.width,
      y = gaze.bounds.y + gaze.y * gaze.bounds.height;
    const radius = Math.max(
      55,
      Math.min(150, Math.hypot(gaze.bounds.width, gaze.bounds.height) * 0.075),
    );
    const score = (o: GazeObject) =>
      distanceToObject(x, y, o.bounds) +
      Math.hypot(
        x - o.bounds.x - o.bounds.width / 2,
        y - o.bounds.y - o.bounds.height / 2,
      ) *
        0.18 +
      (o.source === 'text' ? 12 : 0);
    const ranked = this.objects
      .filter((o) => distanceToObject(x, y, o.bounds) <= radius)
      .map((o) => ({ o, score: score(o) }))
      .sort((a, b) => a.score - b.score);
    const best = ranked[0];
    const ambiguous =
      !!best &&
      !!ranked[1] &&
      ranked[1].score - best.score < 10 &&
      distanceToObject(x, y, best.o.bounds) > 0 &&
      distanceToObject(x, y, ranked[1].o.bounds) > 0;
    if (this.locked) {
      const retained =
        distanceToObject(x, y, this.locked.bounds) <= radius * 0.65;
      if (retained) this.outsideAt = null;
      else this.outsideAt ??= now;
      const challenger =
        best &&
        !ambiguous &&
        best.o.id !== this.locked.id &&
        best.score + 24 < score(this.locked);
      if (challenger) {
        if (this.pending?.id !== best.o.id) {
          this.pending = best.o;
          this.pendingAt = now;
        }
        if (now - this.pendingAt >= 650) {
          this.locked = best.o;
          this.lockedAt = now;
          this.pending = undefined;
          this.outsideAt = null;
        }
      } else this.pending = undefined;
      if (!retained && this.outsideAt !== null && now - this.outsideAt >= 400) {
        this.locked = undefined;
      } else
        return {
          phase: 'locked',
          target: this.locked,
          progress: 1,
          since: this.lockedAt,
        };
    }
    if (!best || ambiguous) {
      this.pending = undefined;
      return { phase: ambiguous ? 'ambiguous' : 'searching', progress: 0 };
    }
    if (this.pending?.id !== best.o.id) {
      this.pending = best.o;
      this.pendingAt = now;
    }
    const progress = Math.min(1, (now - this.pendingAt) / 700);
    if (progress === 1) {
      this.locked = best.o;
      this.lockedAt = now;
      this.pending = undefined;
      return { phase: 'locked', target: this.locked, progress: 1, since: now };
    }
    return {
      phase: 'candidate',
      target: best.o,
      progress,
      since: this.pendingAt,
    };
  }
}

export function objectGaze(gaze: DesktopGaze, target: GazeObject): DesktopGaze {
  return {
    ...gaze,
    x: Math.max(
      0,
      Math.min(
        1,
        (target.bounds.x + target.bounds.width / 2 - gaze.bounds.x) /
          gaze.bounds.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1,
        (target.bounds.y + target.bounds.height / 2 - gaze.bounds.y) /
          gaze.bounds.height,
      ),
    ),
    target,
  };
}
