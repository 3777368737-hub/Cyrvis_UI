/** Keep a failed desktop task distinct from a successful handoff. */
export function describeGUIError(error: unknown): string {
  let raw =
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    if (typeof parsed.message === 'string') raw = parsed.message;
  } catch {
    /* Plain errors are already usable. */
  }
  if (/timed out|timeout|超时/i.test(raw))
    return '桌面视觉模型请求超时，本次操作未完成。请稍后重试，或检查模型服务状态。';
  if (/InsufficientBalance|Arrearage|arrears|欠费|余额不足/i.test(raw))
    return '模型服务返回账户余额不足或欠费，请检查费用中心；本次桌面操作未完成。';
  if (/AgentPlanQuotaExceeded|QuotaExceeded|quota.{0,20}exceed/i.test(raw))
    return '模型服务返回套餐额度已用尽，请检查套餐用量和恢复时间；本次桌面操作未完成。';
  if (/AgentPlanDeductNotEnabled/i.test(raw))
    return '模型服务未启用 Agent Plan 抵扣，请检查套餐抵扣设置；本次桌面操作未完成。';
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}
