import { whenLabel } from './when-label';
export type AnyRecord = Record<string, unknown>;

export function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    current = record[key];
  }
  return current;
}

export function firstString(value: unknown, keys: string[]): string {
  const record = asRecord(value);
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item;
    if (typeof item === 'number') return String(item);
  }
  return '';
}

export function firstArray(value: unknown, keys: string[]): unknown[] {
  const record = asRecord(value);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export function firstArrayAtPath(value: unknown, paths: string[][]): unknown[] {
  if (Array.isArray(value)) return value;
  for (const path of paths) {
    const item = readPath(value, path);
    if (Array.isArray(item)) return item;
  }
  return [];
}

export function bestId(value: unknown): string {
  return firstString(value, ['id', 'sessionId', 'taskId', 'approvalId', 'providerId', 'sourceId', 'nodeId', 'username', 'modelId', 'registryKey']);
}

export function bestTitle(value: unknown, fallback = 'Untitled'): string {
  return firstString(value, ['title', 'name', 'label', 'displayName', 'summary', 'providerId', 'modelId', 'id', 'registryKey']) || fallback;
}

export function bestStatus(value: unknown): string {
  return firstString(value, ['status', 'state', 'phase', 'health', 'authFreshness', 'kind']) || 'unknown';
}

export function countFrom(value: unknown, keys: string[]): number {
  const record = asRecord(value);
  for (const key of keys) {
    const item = record[key];
    if (Array.isArray(item)) return item.length;
    if (typeof item === 'number') return item;
  }
  return 0;
}

export function formatRelative(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return whenLabel(value) || 'unknown';
  if (typeof value === 'string' && value.trim()) return value;
  return 'unknown';
}

/**
 * Human-readable byte size ("148 KB", "142.9 MB", "1.1 GB"). `null`/`undefined`/negative
 * render as an em dash, the same "no verdict" convention formatLatency/routeLabel use
 * (daemon-health.ts), never a fabricated "0 B". Whole bytes stay a plain integer with a
 * "B" suffix (no decimal noise for tiny values).
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
