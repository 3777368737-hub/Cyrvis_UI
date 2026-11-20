import { describe, it, expect } from 'vitest';
import {
  CORRECTION_TARGETS,
  VALIDATE_TARGETS,
  fitScreenCorrection,
  applyScreenCorrection,
  summarizeValidation,
} from './processing';
describe('separate screen bias calibration', () => {
  const width = 1400,
    height = 900;
  const distort = (x: number, y: number) => ({
    x: (1.1 * x + 0.06) * width,
    y: (0.05 * x + 0.9 * y + 0.07) * height,
  });
  const calibration = () =>
    CORRECTION_TARGETS.map((target) => ({
      target,
      samples: Array.from({ length: 20 }, (_, i) => {
        const p = distort(target.x, target.y);
        return { x: p.x + (i % 2 ? 5 : -5), y: p.y };
      }),
    }));
  it('corrects translation/scale/shear on genuinely held-out positions', () => {
    expect(
      VALIDATE_TARGETS.every(
        (t) => !CORRECTION_TARGETS.some((p) => p.x === t.x && p.y === t.y),
      ),
    ).toBe(true);
    const correction = fitScreenCorrection(calibration(), width, height);
    expect(correction).not.toBeNull();
    const raw = VALIDATE_TARGETS.map((target) => ({
      target,
      samples: Array.from({ length: 20 }, () => distort(target.x, target.y)),
    }));
    const adjusted = raw.map((v) => ({
      ...v,
      samples: v.samples.map((p) =>
        applyScreenCorrection(p, correction, width, height),
      ),
    }));
    expect(summarizeValidation(adjusted, width, height).mean).toBeLessThan(2);
    expect(summarizeValidation(raw, width, height).mean).toBeGreaterThan(80);
  });
  it('rejects collapsed predictions, inadequate samples and reversed mappings', () => {
    const collapsed = calibration().map((p) => ({
      ...p,
      samples: Array(20).fill({ x: 300, y: 300 }),
    }));
    expect(fitScreenCorrection(collapsed, width, height)).toBeNull();
    expect(
      fitScreenCorrection(calibration().slice(1), width, height),
    ).toBeNull();
    const flipped = CORRECTION_TARGETS.map((target) => ({
      target,
      samples: Array(20).fill({
        x: (1 - target.x) * width,
        y: target.y * height,
      }),
    }));
    expect(fitScreenCorrection(flipped, width, height)).toBeNull();
  });
  it('does not change raw input or clamp bad predictions into a passing score', () => {
    const p = { x: -100, y: 2000 };
    const c = {
      x: [1, 0, 0] as [number, number, number],
      y: [0, 1, 0] as [number, number, number],
    };
    expect(applyScreenCorrection(p, c, width, height)).toEqual(p);
    expect(applyScreenCorrection(p, null, width, height)).toEqual(p);
  });
});
