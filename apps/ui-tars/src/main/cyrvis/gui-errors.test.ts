import { describe, expect, it } from 'vitest';
import { describeGUIError } from './gui-errors';

describe('desktop task failures', () => {
  it('reports a model timeout instead of suggesting that playback is underway', () => {
    expect(
      describeGUIError(new Error('INVOKE_RETRY_ERROR: Request timed out.')),
    ).toContain('操作未完成');
    expect(
      describeGUIError(JSON.stringify({ message: 'Request timed out.' })),
    ).toContain('请求超时');
    expect(describeGUIError({ message: 'Request timed out.' })).toContain(
      '请求超时',
    );
  });
  it('keeps actual balance errors distinct from plan quota and plan settings', () => {
    expect(describeGUIError('InsufficientBalance')).toContain('欠费');
    expect(describeGUIError('QuotaExceeded.AgentPlanQuotaExceeded')).toContain(
      '套餐额度',
    );
    expect(describeGUIError('Forbidden.AgentPlanDeductNotEnabled')).toContain(
      '抵扣设置',
    );
    expect(describeGUIError('network temporarily unavailable')).toBe(
      'network temporarily unavailable',
    );
  });
});
