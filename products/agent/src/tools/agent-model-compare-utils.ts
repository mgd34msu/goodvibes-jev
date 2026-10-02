export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

export function readOptionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  return readBoolean(value);
}

export function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function readBenchmarkKind(value: unknown): string {
  return readComparisonTag(value);
}

export function readComparisonTag(value: unknown): string {
  return readString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

export function previewText(value: string, limit = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

export function isTextLike(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('yaml')
    || normalized.includes('csv')
    || normalized.includes('javascript')
    || normalized.includes('typescript')
    || normalized.includes('markdown');
}

export function readModelRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => readString(entry))
      .filter(Boolean);
  }
  const text = readString(value);
  if (!text) return [];
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function readStringList(value: unknown): readonly string[] {
  const raw = Array.isArray(value)
    ? value
    : readString(value).split(/[\n,]/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const text = readString(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
