export const HARNESS_PREVIEW_LIMIT = 56;

export function previewHarnessText(value: string, maxLength = HARNESS_PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
