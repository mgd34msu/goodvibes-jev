import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { readYesNo, type YesNoReading } from '@goodvibes-jev/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { inboxTriage, TRIAGE_MODEL } from './battery.js';
import type { TriageBinding, TriageEvidence, TriageInput, TriageLabel, TriageReceipt } from './types.js';

/** Descriptor-only capture checks every property, including hidden data, without invoking user code. */
export function captureTriageData(value: unknown): unknown {
  let nodes = 0, chars = 0;
  const active = new Set<object>();
  const invalid = (): never => { throw new JudgmentInputError('unsupported-input'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { chars += entry.length; return chars > 1_000_000 ? invalid() : entry; }
    if (entry === undefined || entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || active.has(entry)) return invalid();
    const array = Array.isArray(entry), proto: unknown = Object.getPrototypeOf(entry);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string') || keys.length > 20_000) return invalid();
    if (Object.values(descriptors).some(d => !('value' in d))) return invalid();
    const length: unknown = array ? descriptors['length']?.value : 0;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 20_000) return invalid();
    if (array && (keys.length !== length + 1 || Array.from({length}, (_, i) => i).some(i => !Object.hasOwn(descriptors, String(i))))) return invalid();
    active.add(entry);
    const copy: object = array ? new Array(length) : {};
    for (const key of Object.keys(descriptors).sort()) {
      if (array && key === 'length') continue;
      Object.defineProperty(copy, key, { value: capture(descriptors[key]!.value, depth + 1), enumerable: true });
    }
    active.delete(entry);
    return Object.freeze(copy);
  };
  return capture(value, 0);
}

export interface CapturedTriageInput {
  readonly id: string; readonly surface: string; readonly subject: string; readonly snippet: string;
  readonly conversationKind: string; readonly unread: boolean;
}
const invalid = (): never => { throw new JudgmentInputError('unsupported-input'); };
/** Original input is fully captured and privacy-inspected before any projection or digest. */
export function captureTriageInputs(items: readonly TriageInput[]): readonly CapturedTriageInput[] {
  const captured = captureTriageData(items);
  snapshotJudgmentInput(captured);
  if (!Array.isArray(captured) || captured.length > 100) return invalid();
  const seen = new Set<string>();
  return Object.freeze(captured.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const item = value as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !item['id'].trim() || item['id'].length > 500 || seen.has(item['id'])
      || typeof item['surface'] !== 'string' || !item['surface'].trim() || item['surface'].length > 100
      || (item['subject'] !== undefined && typeof item['subject'] !== 'string')
      || (item['snippet'] !== undefined && typeof item['snippet'] !== 'string')
      || (item['unread'] !== undefined && typeof item['unread'] !== 'boolean')
      || (item['conversationKind'] !== undefined && !['direct','group','channel','thread','service'].includes(String(item['conversationKind'])))) return invalid();
    seen.add(item['id']);
    return Object.freeze({ id: item['id'], surface: item['surface'], subject: (item['subject'] ?? '') as string,
      snippet: (item['snippet'] ?? '') as string, conversationKind: (item['conversationKind'] ?? 'service') as string,
      unread: (item['unread'] ?? false) as boolean });
  }));
}
export function triageBinding(input: CapturedTriageInput): TriageBinding {
  return Object.freeze({ id: input.id, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL });
}
const round = (p: number): number => Math.round(p * 100) / 100;
export function labelToTag(label: TriageLabel): string {
  return ({ spam: 'GoodVibes/Spam', priority: 'GoodVibes/Priority', normal: 'GoodVibes/Normal' })[label];
}
export function settleTriage(binding: TriageBinding, spam: YesNoReading, urgency: YesNoReading): TriageReceipt {
  if (spam.outcome !== 'act' || urgency.outcome !== 'act') return Object.freeze({ ...binding, status: 'held' });
  const label: TriageLabel = spam.verdict === 'yes' && spam.probability >= urgency.probability ? 'spam'
    : urgency.verdict === 'yes' ? 'priority' : 'normal';
  const score = round(label === 'spam' ? spam.probability : label === 'priority' ? urgency.probability : 1 - Math.max(spam.probability, urgency.probability));
  return Object.freeze({ ...binding, status: 'settled', spam: Object.freeze({...spam}), urgency: Object.freeze({...urgency}),
    label, score, tags: Object.freeze([labelToTag(label)]), signals: Object.freeze({ spam: round(spam.probability), urgency: round(urgency.probability) }) });
}
/** Validate untrusted evidence as data, re-derive its conclusions, and return an immutable owned value. */
export function checkTriageReceipt(value: unknown): TriageReceipt {
  const safe = captureTriageData(value);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return invalid();
  const row = safe as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || !row['id'].trim() || row['id'].length > 500
    || typeof row['inputHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['inputHash'])
    || row['battery'] !== inboxTriage.name || row['batteryVersion'] !== inboxTriage.version || row['model'] !== TRIAGE_MODEL) return invalid();
  const binding: TriageBinding = { id: row['id'], inputHash: row['inputHash'], battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL };
  if (row['status'] === 'held' || row['status'] === 'unavailable') {
    const expected = Object.freeze({ ...binding, status: row['status'] });
    if (!isDeepStrictEqual(safe, expected)) return invalid();
    return expected;
  }
  if (row['status'] !== 'settled') return invalid();
  const reading = (raw: unknown, key: 'spam' | 'urgency'): YesNoReading => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const p: unknown = (raw as Record<string, unknown>)['probability'];
    if (typeof p !== 'number' || p < 0 || p > 1) return invalid();
    const checked = readYesNo({ type: 'noul', noul: p }, inboxTriage.items[key].band);
    if (!isDeepStrictEqual(raw, checked)) return invalid();
    return checked;
  };
  const expected = settleTriage(binding, reading(row['spam'], 'spam'), reading(row['urgency'], 'urgency'));
  if (expected.status !== 'settled' || !isDeepStrictEqual(safe, expected)) return invalid();
  return expected as TriageEvidence;
}
