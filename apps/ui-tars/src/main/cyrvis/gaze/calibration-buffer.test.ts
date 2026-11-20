import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TRAIN_TARGETS,
  SAMPLES_PER_TARGET,
  TRAINING_BUFFER_SIZE,
  trainingCoverage,
} from './processing';
const source = readFileSync(
  resolve(__dirname, '../../../renderer/public/gaze/webgazer.js'),
  'utf8',
);
describe('vendored regression capacity', () => {
  it('allocates the configured capacity in the actual vendor initializer', () => {
    const start = source.indexOf('InitRegression:function(){');
    const end = source.indexOf(',KalmanFilter:function', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const text = source.slice(start + 'InitRegression:'.length, end);
    class DataWindow {
      constructor(public size: number) {}
    }
    const initialize = new Function(
      'BP',
      'kW',
      'vW',
      'IW',
      `return (${text});`,
    )(
      { calibrationBufferSize: TRAINING_BUFFER_SIZE, moveTickSize: 50 },
      { DataWindow },
      { identity: () => [], multScalar: (v: unknown) => v },
      { KalmanFilter: class {} },
    );
    const regression: any = {};
    initialize.call(regression);
    for (const field of [
      'screenXClicksArray',
      'screenYClicksArray',
      'eyeFeaturesClicks',
      'dataClicks',
    ])
      expect(regression[field].size).toBeGreaterThanOrEqual(
        TRAIN_TARGETS.length * SAMPLES_PER_TARGET,
      );
  });
  it('detects the original 50-sample eviction pattern before validation can run', () => {
    const samples = TRAIN_TARGETS.flatMap((target) =>
      Array.from({ length: SAMPLES_PER_TARGET }, () => ({
        screenPos: [target.x * 1000, target.y * 800],
      })),
    );
    expect(trainingCoverage(samples, 1000, 800)).toEqual({
      complete: true,
      counts: Array(9).fill(20),
    });
    const evicted = trainingCoverage(samples.slice(-50), 1000, 800);
    expect(evicted.complete).toBe(false);
    expect(evicted.counts.slice(0, 6)).toEqual(Array(6).fill(0));
  });
});
