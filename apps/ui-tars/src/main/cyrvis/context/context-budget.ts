export const composeContextSections = (
  sections: Array<string | null | undefined>,
  maxChars = 12_000,
): string => {
  const limit = Math.max(1_000, Math.floor(maxChars));
  const selected: string[] = [];
  let used = 0;
  for (const section of sections) {
    const normalized = section?.trim();
    if (!normalized || used >= limit) {
      continue;
    }
    const separator = selected.length ? 2 : 0;
    const remaining = limit - used - separator;
    if (remaining <= 0) {
      break;
    }
    selected.push(
      normalized.length <= remaining
        ? normalized
        : `${normalized.slice(0, Math.max(0, remaining - 24)).trimEnd()}\n[context truncated]`,
    );
    used += Math.min(normalized.length, remaining) + separator;
  }
  return selected.join('\n\n');
};
