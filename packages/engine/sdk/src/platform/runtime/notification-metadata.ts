/** Code-owned identifiers only; arbitrary plugin/custom names remain content. */
const TOOLS: ReadonlySet<string> = new Set([
  'read', 'find', 'fetch', 'write', 'edit', 'exec', 'analyze', 'inspect', 'agent', 'profile',
]);
const CATEGORIES: ReadonlySet<string> = new Set(['read', 'write', 'execute', 'delegate']);

export function notificationTool(value: unknown): string | undefined {
  return typeof value === 'string' && TOOLS.has(value) ? value : undefined;
}
export function notificationCategory(value: unknown): string | undefined {
  return typeof value === 'string' && CATEGORIES.has(value) ? value : undefined;
}
export function notificationSubject(value: unknown): string {
  if (value === undefined || value === 'turn') return 'turn';
  return value === 'agent' || value === 'contract' ? value : 'work';
}

export function notificationNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('Invalid notification facts');
  return value;
}
export function notificationOutcome(value: unknown): 'completed' | 'failed' | 'cancelled' {
  if (value !== 'completed' && value !== 'failed' && value !== 'cancelled') throw new TypeError('Invalid notification facts');
  return value;
}

/** Optional content is copied as a primitive, never coerced through caller code. */
export function notificationOptionalText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError('Invalid notification facts');
  return value;
}
