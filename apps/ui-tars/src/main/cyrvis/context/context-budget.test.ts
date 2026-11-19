import { describe, expect, it } from 'vitest';

import { composeContextSections } from './context-budget';

describe('composeContextSections', () => {
  it('keeps context within the configured character budget', () => {
    const result = composeContextSections(
      ['dynamic '.repeat(200), 'memory '.repeat(200), 'system '.repeat(200)],
      1_000,
    );
    expect(result.length).toBeLessThanOrEqual(1_000);
    expect(result).toContain('[context truncated]');
  });

  it('preserves section priority order', () => {
    expect(
      composeContextSections(['dynamic', 'memory', 'system'], 12_000),
    ).toBe('dynamic\n\nmemory\n\nsystem');
  });
});
