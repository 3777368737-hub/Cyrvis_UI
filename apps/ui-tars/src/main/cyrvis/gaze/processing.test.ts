import { describe, it, expect } from 'vitest';
import {
  AdaptiveGazeFilter,
  FaceGate,
  TargetSampler,
  summarizeValidation,
  VALIDATE_TARGETS,
  TRAIN_TARGETS,
  SAMPLES_PER_TARGET,
} from './processing';
describe('gaze signal processing', () => {
  it('rejects invalid face frames and waits for a sustained open-eye steady pose', () => {
    const landmarks = Array.from({ length: 468 }, () => [50, 50]);
    landmarks[33] = [0, 0];
    landmarks[133] = [20, 0];
    landmarks[159] = [10, 4];
    landmarks[145] = [10, 0];
    landmarks[263] = [100, 0];
    landmarks[362] = [80, 0];
    landmarks[386] = [90, 4];
    landmarks[374] = [90, 0];
    const gate = new FaceGate();
    expect(gate.update(landmarks, false, 0)).toBe(false);
    expect(gate.update(landmarks, true, 0)).toBe(false);
    expect(gate.update(landmarks, true, 200)).toBe(false);
    expect(gate.update(landmarks, true, 400)).toBe(true);
    const blink = landmarks.map((p) => [...p]);
    blink[159] = [10, 0.2];
    expect(gate.update(blink, true, 450)).toBe(false);
    expect(gate.update(landmarks, true, 500)).toBe(false);
  });
  it('restarts steadiness after substantial head movement', () => {
    const gate = new FaceGate();
    const p = Array.from({ length: 468 }, () => [50, 50]);
    Object.assign(p, {
      33: [0, 0],
      133: [20, 0],
      159: [10, 4],
      145: [10, 0],
      263: [100, 0],
      362: [80, 0],
      386: [90, 4],
      374: [90, 0],
    });
    gate.update(p, true, 0);
    expect(gate.update(p, true, 400)).toBe(true);
    p[1] = [90, 50];
    expect(gate.update(p, true, 450)).toBe(false);
  });
  it('samples only spaced valid frames after settling, without burst duplicates', () => {
    const sampler = new TargetSampler();
    sampler.reset(1000);
    expect(sampler.tick(1800, true)).toBe(false);
    expect(sampler.tick(1900, false)).toBe(false);
    expect(sampler.tick(1900, true)).toBe(true);
    expect(sampler.tick(1910, true)).toBe(false);
    for (let i = 1; i < SAMPLES_PER_TARGET; i++)
      expect(sampler.tick(1900 + i * 100, true)).toBe(true);
    expect(sampler.collected).toBe(20);
    expect(sampler.tick(5000, true)).toBe(false);
  });
  it('keeps validation targets independent and reports true held-out bias', () => {
    expect(
      VALIDATE_TARGETS.every(
        (t) => !TRAIN_TARGETS.some((p) => p.x === t.x && p.y === t.y),
      ),
    ).toBe(true);
    const points = VALIDATE_TARGETS.map((target) => ({
      target,
      samples: Array.from({ length: 20 }, () => ({
        x: target.x * 1000 + 30,
        y: target.y * 800 + 40,
      })),
    }));
    const result = summarizeValidation(points, 1000, 800);
    expect(result.mean).toBeCloseTo(50);
    expect(result.median).toBeCloseTo(50);
    expect(result.p90).toBeCloseTo(50);
    expect(() => summarizeValidation(points.slice(1), 1000, 800)).toThrow(
      '样本不足',
    );
    const bad = points.map((v) => ({
      ...v,
      samples: v.samples.map((p) => ({ x: p.x + 250, y: p.y })),
    }));
    expect(summarizeValidation(bad, 1000, 800).passed).toBe(false);
  });
  it('reduces fixation noise while reacting faster to a genuine target switch', () => {
    const filter = new AdaptiveGazeFilter();
    const fixed = new AdaptiveGazeFilter(1.2, 0);
    let output = 0;
    let fixedOutput = 0;
    const raw: number[] = [],
      smooth: number[] = [];
    for (let i = 0; i < 100; i++) {
      const x = 500 + (i % 2 ? 8 : -8);
      raw.push(x);
      smooth.push(filter.update({ x, y: 500 }, i * 33).x);
      fixed.update({ x, y: 500 }, i * 33);
    }
    const rms = (xs: number[]) =>
      Math.sqrt(
        xs.slice(20).reduce((s, x) => s + (x - 500) ** 2, 0) / (xs.length - 20),
      );
    expect(rms(smooth)).toBeLessThan(rms(raw) * 0.5);
    for (let i = 100; i < 105; i++) {
      output = filter.update({ x: 1000, y: 500 }, i * 33).x;
      fixedOutput = fixed.update({ x: 1000, y: 500 }, i * 33).x;
    }
    expect(output).toBeGreaterThan(fixedOutput);
    expect(output).toBeLessThanOrEqual(1000);
    expect(filter.update({ x: 200, y: 200 }, 6000)).toEqual({ x: 200, y: 200 });
  });
});

describe('validation error decomposition', () => {
  it('separates a repeatable 50px offset from 10px fixation jitter', () => {
    const points = VALIDATE_TARGETS.map((target) => ({
      target,
      samples: Array.from({ length: 20 }, (_, i) => ({
        x: target.x * 1000 + 30 + (i % 2 ? 10 : -10),
        y: target.y * 800 + 40,
      })),
    }));
    const result = summarizeValidation(points, 1000, 800);
    expect(result.biasRms).toBeCloseTo(50);
    expect(result.jitterRms).toBeCloseTo(10);
    expect(result.meanDx).toBeCloseTo(30);
    expect(result.meanDy).toBeCloseTo(40);
  });
  it('does not mistake large symmetric noise for a center offset', () => {
    const points = VALIDATE_TARGETS.map((target) => ({
      target,
      samples: Array.from({ length: 20 }, (_, i) => ({
        x: target.x * 1000 + (i % 2 ? 200 : -200),
        y: target.y * 800,
      })),
    }));
    const result = summarizeValidation(points, 1000, 800);
    expect(result.biasRms).toBeCloseTo(0);
    expect(result.jitterRms).toBeCloseTo(200);
    expect(result.passed).toBe(false);
  });
});
