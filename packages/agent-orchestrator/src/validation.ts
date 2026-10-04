export function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty.`);
  }
  return normalized;
}
