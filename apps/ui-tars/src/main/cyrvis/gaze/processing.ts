/** Pure eye-tracking signal processing. Pixels are viewport CSS/logical pixels. */
export type Point = { x: number; y: number };
export const TRAIN_TARGETS: Point[] = [0.12, 0.5, 0.88].flatMap((y) =>
  [0.12, 0.5, 0.88].map((x) => ({ x, y })),
);
// These positions never enter the regression's training data.
export const VALIDATE_TARGETS: Point[] = [
  { x: 0.27, y: 0.3 },
  { x: 0.73, y: 0.3 },
  { x: 0.5, y: 0.65 },
  { x: 0.27, y: 0.78 },
  { x: 0.73, y: 0.78 },
];
export const SAMPLES_PER_TARGET = 20;
export const TRAINING_BUFFER_SIZE =
  TRAIN_TARGETS.length * SAMPLES_PER_TARGET + 20;
export function trainingCoverage(
  samples: { screenPos: number[] }[],
  width: number,
  height: number,
) {
  const counts = TRAIN_TARGETS.map(
    (target) =>
      samples.filter(
        (sample) =>
          Array.isArray(sample.screenPos) &&
          Math.abs(sample.screenPos[0] - target.x * width) < 1 &&
          Math.abs(sample.screenPos[1] - target.y * height) < 1,
      ).length,
  );
  return {
    counts,
    complete: counts.every((count) => count >= SAMPLES_PER_TARGET),
  };
}
const alpha = (cutoff: number, dt: number) =>
  1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
class AxisFilter {
  private value: number | null = null;
  private raw = 0;
  private derivative = 0;
  reset() {
    this.value = null;
    this.derivative = 0;
  }
  filter(raw: number, dt: number, minCutoff: number, beta: number) {
    if (this.value === null) {
      this.value = this.raw = raw;
      return raw;
    }
    const speed = (raw - this.raw) / dt;
    this.raw = raw;
    this.derivative += alpha(1, dt) * (speed - this.derivative);
    this.value +=
      alpha(minCutoff + beta * Math.abs(this.derivative), dt) *
      (raw - this.value);
    return this.value;
  }
}
/** Casiez et al. 1€ filter; timestamps in ms, beta tuned for pixel units. */
export class AdaptiveGazeFilter {
  private x = new AxisFilter();
  private y = new AxisFilter();
  private at: number | null = null;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.015,
  ) {}
  reset() {
    this.at = null;
    this.x.reset();
    this.y.reset();
  }
  update(point: Point, at: number): Point {
    if (this.at !== null && (at <= this.at || at - this.at > 500)) this.reset();
    const dt =
      this.at === null ? 1 / 30 : Math.max(0.001, (at - this.at) / 1000);
    this.at = at;
    return {
      x: this.x.filter(point.x, dt, this.minCutoff, this.beta),
      y: this.y.filter(point.y, dt, this.minCutoff, this.beta),
    };
  }
}
export type HeadPose = { x: number; y: number; scale: number };
/** Requires fresh eye patches, open eyes and 400ms of steady head pose. */
export class FaceGate {
  private poses: { at: number; pose: HeadPose }[] = [];
  reset() {
    this.poses = [];
  }
  update(
    landmarks: number[][] | null,
    hasPatches: boolean,
    at: number,
  ): boolean {
    if (!hasPatches || !landmarks || landmarks.length < 387) {
      this.reset();
      return false;
    }
    const p = (i: number) => landmarks[i];
    const dist = (a: number, b: number) =>
      Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]);
    const scale = dist(33, 263);
    const left = dist(159, 145) / dist(33, 133);
    const right = dist(386, 374) / dist(362, 263);
    const pose = { x: p(1)[0], y: p(1)[1], scale };
    if (
      ![scale, left, right, pose.x, pose.y].every(Number.isFinite) ||
      scale < 20 ||
      left < 0.12 ||
      right < 0.12
    ) {
      this.reset();
      return false;
    }
    this.poses = this.poses.filter((v) => at - v.at <= 600);
    this.poses.push({ at, pose });
    const base = this.poses[0];
    if (
      this.poses.some(
        (v) =>
          Math.hypot(v.pose.x - pose.x, v.pose.y - pose.y) > scale * 0.06 ||
          Math.abs(v.pose.scale / scale - 1) > 0.07,
      )
    ) {
      this.poses = [{ at, pose }];
      return false;
    }
    return at - base.at >= 400;
  }
}
export type ValidationPoint = { target: Point; samples: Point[] };
export function summarizeValidation(
  points: ValidationPoint[],
  width: number,
  height: number,
) {
  const distance = (p: Point, t: Point) =>
    Math.hypot(p.x - t.x * width, p.y - t.y * height);
  const errors = points
    .flatMap((v) => v.samples.map((p) => distance(p, v.target)))
    .sort((a, b) => a - b);
  if (
    points.length !== VALIDATE_TARGETS.length ||
    points.some((p) => p.samples.length < SAMPLES_PER_TARGET) ||
    !errors.length
  )
    throw Error('验证样本不足');
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const median = errors[Math.floor(errors.length / 2)],
    p90 = errors[Math.ceil(errors.length * 0.9) - 1];
  const diagonal = Math.hypot(width, height);
  const perPoint = points.map((v) => {
    const center = {
      x: v.samples.reduce((n, p) => n + p.x, 0) / v.samples.length,
      y: v.samples.reduce((n, p) => n + p.y, 0) / v.samples.length,
    };
    const dx = center.x - v.target.x * width,
      dy = center.y - v.target.y * height;
    const jitter = Math.sqrt(
      v.samples.reduce(
        (n, p) => n + (p.x - center.x) ** 2 + (p.y - center.y) ** 2,
        0,
      ) / v.samples.length,
    );
    return {
      target: v.target,
      center,
      dx,
      dy,
      jitter,
      bias: Math.hypot(dx, dy),
      count: v.samples.length,
      mean:
        v.samples.reduce((n, p) => n + distance(p, v.target), 0) /
        v.samples.length,
    };
  });
  const total = errors.length;
  const biasRms = Math.sqrt(
    perPoint.reduce((n, p) => n + p.count * p.bias ** 2, 0) / total,
  );
  const jitterRms = Math.sqrt(
    perPoint.reduce((n, p) => n + p.count * p.jitter ** 2, 0) / total,
  );
  const meanDx = perPoint.reduce((n, p) => n + p.dx * p.count, 0) / total,
    meanDy = perPoint.reduce((n, p) => n + p.dy * p.count, 0) / total;
  return {
    mean,
    median,
    p90,
    diagonal,
    width,
    height,
    biasRms,
    jitterRms,
    meanDx,
    meanDy,
    passed: mean <= diagonal * 0.06 && p90 <= diagonal * 0.1,
    perPoint,
  };
}
/** Settling + sample spacing; failed quality frames never advance sampling. */
export class TargetSampler {
  private entered = 0;
  private last = -Infinity;
  private count = 0;
  reset(at: number) {
    this.entered = at;
    this.last = -Infinity;
    this.count = 0;
  }
  tick(at: number, quality: boolean) {
    if (
      !quality ||
      at - this.entered < 900 ||
      at - this.last < 100 ||
      this.count >= SAMPLES_PER_TARGET
    )
      return false;
    this.last = at;
    this.count++;
    return true;
  }
  get collected() {
    return this.count;
  }
}

/** A separate post-regression calibration set, never used for validation scoring. */
export const CORRECTION_TARGETS: Point[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.5, y: 0.5 },
  { x: 0.2, y: 0.8 },
  { x: 0.8, y: 0.8 },
];
export type ScreenCorrection = {
  x: [number, number, number];
  y: [number, number, number];
};
function solve3(matrix: number[][], rhs: number[]): number[] | null {
  const rows = matrix.map((r, i) => [...r, rhs[i]]);
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++)
      if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-8) return null;
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c];
    rows[c] = rows[c].map((v) => v / divisor);
    for (let r = 0; r < 3; r++)
      if (r !== c) {
        const factor = rows[r][c];
        rows[r] = rows[r].map((v, j) => v - factor * rows[c][j]);
      }
  }
  return rows.map((r) => r[3]);
}
const medianOf = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
export function fitScreenCorrection(
  points: ValidationPoint[],
  width: number,
  height: number,
): ScreenCorrection | null {
  if (
    width <= 0 ||
    height <= 0 ||
    points.length !== CORRECTION_TARGETS.length ||
    points.some((p) => p.samples.length < SAMPLES_PER_TARGET)
  )
    return null;
  const rows = points.map((p) => [
    medianOf(p.samples.map((s) => s.x)) / width,
    medianOf(p.samples.map((s) => s.y)) / height,
    1,
  ]);
  if (!rows.flat().every(Number.isFinite)) return null;
  if (
    Math.max(...rows.map((r) => r[0])) - Math.min(...rows.map((r) => r[0])) <
      0.2 ||
    Math.max(...rows.map((r) => r[1])) - Math.min(...rows.map((r) => r[1])) <
      0.2
  )
    return null;
  const matrix = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) =>
      rows.reduce((s, r) => s + r[i] * r[j], 0),
    ),
  );
  // Small identity prior prevents unstable affine extrapolation.
  const lambda = 0.001;
  for (let i = 0; i < 3; i++) matrix[i][i] += lambda;
  const fit = (axis: 'x' | 'y') =>
    solve3(
      matrix,
      Array.from(
        { length: 3 },
        (_, i) =>
          rows.reduce((s, r, k) => s + r[i] * points[k].target[axis], 0) +
          (i === (axis === 'x' ? 0 : 1) ? lambda : 0),
      ),
    );
  const x = fit('x'),
    y = fit('y');
  if (!x || !y || ![...x, ...y].every(Number.isFinite)) return null;
  const det = x[0] * y[1] - x[1] * y[0];
  if (
    det < 0.25 ||
    det > 4 ||
    x[0] < 0.5 ||
    x[0] > 2 ||
    y[1] < 0.5 ||
    y[1] > 2 ||
    Math.abs(x[1]) > 0.75 ||
    Math.abs(y[0]) > 0.75 ||
    Math.abs(x[2]) > 0.5 ||
    Math.abs(y[2]) > 0.5
  )
    return null;
  return { x: x as [number, number, number], y: y as [number, number, number] };
}
export function applyScreenCorrection(
  point: Point,
  correction: ScreenCorrection | null,
  width: number,
  height: number,
): Point {
  if (!correction) return point;
  const x = point.x / width,
    y = point.y / height;
  // Do not clamp: off-screen predictions must remain errors during validation.
  return {
    x: (correction.x[0] * x + correction.x[1] * y + correction.x[2]) * width,
    y: (correction.y[0] * x + correction.y[1] * y + correction.y[2]) * height,
  };
}
