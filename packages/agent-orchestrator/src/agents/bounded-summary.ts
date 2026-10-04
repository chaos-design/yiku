const SUMMARY_LIMIT = 240;

export function boundedSummary(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= SUMMARY_LIMIT
    ? normalized
    : `${normalized.slice(0, SUMMARY_LIMIT - 3)}...`;
}
