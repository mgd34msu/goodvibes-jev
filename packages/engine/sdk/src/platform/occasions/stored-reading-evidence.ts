/** Internal projections of machine-owned state; never a caller-input admission shortcut. */
import { captureOwnedJson, snapshotJudgmentInput, JudgmentInputError, type JudgmentInputProblem } from '../gate/judgment-input.js';
import { OccasionReadingHeldError, type OccasionReadingWork } from './readings.js';
import { isIsoDate } from './dates.js';
import { isOccasionAckSource, isOccasionAnswer, isRaiseBoundary, type GiftRecord, type OccasionAcknowledgement, type OpenItem } from './types.js';

function requireShape(condition: boolean): asserts condition {
  if (!condition) throw new JudgmentInputError('unsupported-input');
}
/** Unlike JSON.stringify(array), this also binds extra own array properties. */
function identity(value: unknown): string {
  function entries(entry: unknown): unknown {
    return entry !== null && typeof entry === 'object'
      ? [Array.isArray(entry) ? ['array', entry.length] : ['object'], Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, entries(child)])]
      : entry;
  }
  return JSON.stringify(entries(value));
}
function records(value: unknown, work?: OccasionReadingWork): readonly Record<string, unknown>[] {
  const captured = captureOwnedJson(value);
  requireShape(Array.isArray(captured));
  const original = identity(captured);
  work?.retain(() => {
    if (identity(captureOwnedJson(value)) !== original) throw new OccasionReadingHeldError();
  });
  const extras = Object.fromEntries(Object.entries(captured).filter(([key]) => { const index = Number(key); return !(Number.isInteger(index) && index >= 0 && index < captured.length && String(index) === key); }));
  snapshotJudgmentInput(extras);
  const result: Record<string, unknown>[] = [];
  for (let i = 0; i < captured.length; i++) {
    const record: unknown = captured[i];
    requireShape(record !== null && typeof record === 'object' && !Array.isArray(record));
    result.push(record as Record<string, unknown>);
  }
  return result;
}
const text = (value: unknown): value is string => typeof value === 'string';
const clock = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const date = (value: unknown): value is string => text(value) && isIsoDate(value);
const optionalText = (value: unknown): boolean => value === undefined || text(value);
const optionalDate = (value: unknown): boolean => value === undefined || date(value);

/** recordedAt is validated storage bookkeeping. All prose and unexpected fields remain admitted. */
export function storedGiftEvidence(value: unknown, work?: OccasionReadingWork): readonly Omit<GiftRecord, 'recordedAt'>[] {
  return records(value, work).map(record => {
    requireShape(text(record.occasionId) && date(record.occurrence) && text(record.landedOn) && optionalText(record.notes) && clock(record.recordedAt));
    const { recordedAt: _clock, ...evidence } = record;
    return snapshotJudgmentInput(evidence) as Omit<GiftRecord, 'recordedAt'>;
  });
}

/** Only explicitly validated schema-owned clocks are outside the meaning input. */
export function storedOpenItemEvidence(value: unknown, work?: OccasionReadingWork): readonly Omit<OpenItem, 'openedAt' | 'lastRaisedAt'>[] {
  return records(value, work).map(record => {
    requireShape(text(record.id) && text(record.occasionId) && text(record.kind) && ['nudge', 'conflict', 'interview'].includes(record.kind)
      && (date(record.occurrence) || (record.kind === 'conflict' && record.occurrence === ''))
      && clock(record.openedAt) && clock(record.lastRaisedAt) && clock(record.raiseCount)
      && Array.isArray(record.servedBoundaries) && record.servedBoundaries.every(boundary => text(boundary) && isRaiseBoundary(boundary))
      && date(record.dueOn) && optionalDate(record.expiresAfter) && optionalDate(record.agentPushedOn));
    const { openedAt: _opened, lastRaisedAt: _raised, ...evidence } = record;
    return snapshotJudgmentInput(evidence) as Omit<OpenItem, 'openedAt' | 'lastRaisedAt'>;
  });
}

/** Answer/source/date/extra fields remain admitted; answeredAt is validated storage bookkeeping. */
export function storedAcknowledgementEvidence(value: unknown, work?: OccasionReadingWork): readonly Omit<OccasionAcknowledgement, 'answeredAt'>[] {
  return records(value, work).map(record => {
    requireShape(text(record.id) && text(record.occasionId) && date(record.occurrence)
      && text(record.answer) && isOccasionAnswer(record.answer) && clock(record.answeredAt)
      && (record.source === undefined || (text(record.source) && isOccasionAckSource(record.source)))
      && optionalDate(record.expiresAfter) && optionalDate(record.returnOn));
    const { answeredAt: _clock, ...evidence } = record;
    return snapshotJudgmentInput(evidence) as Omit<OccasionAcknowledgement, 'answeredAt'>;
  });
}

/** Value-free provenance, computed before storage sanitation can discard supplied fields. */
export function storedEvidenceProblem(kind: 'gifts' | 'openItems' | 'acknowledgements', value: unknown): JudgmentInputProblem | undefined {
  try {
    if (kind === 'gifts') storedGiftEvidence(value);
    else if (kind === 'openItems') storedOpenItemEvidence(value);
    else storedAcknowledgementEvidence(value);
    return undefined;
  } catch (error) {
    if (error instanceof JudgmentInputError) return error.problem;
    throw error;
  }
}

export interface StoredGiftAdmission {
  readonly collectionProblem: JudgmentInputProblem | undefined;
  readonly problems: ReadonlyMap<string, JudgmentInputProblem>;
  readonly sanitizedOccasions: ReadonlySet<string>;
}
/** Inspect every duplicate and collection extra before the ordinary loader drops fields. */
export function storedGiftAdmission(value: unknown, normalized: readonly GiftRecord[]): StoredGiftAdmission {
  const problems = new Map<string, JudgmentInputProblem>();
  const sanitizedOccasions = new Set<string>();
  let collectionProblem: JudgmentInputProblem | undefined;
  try {
    const captured = records(value);
    const byOccasion = new Map<string, Record<string, unknown>[]>();
    for (const record of captured) {
      if (!text(record.occasionId)) { collectionProblem = 'unsupported-input'; continue; }
      const group = byOccasion.get(record.occasionId) ?? [];
      group.push(record); byOccasion.set(record.occasionId, group);
    }
    for (const [occasionId, group] of byOccasion) {
      const problem = storedEvidenceProblem('gifts', group);
      if (problem) problems.set(occasionId, problem);
      if (identity(group) !== identity(normalized.filter(record => record.occasionId === occasionId))) sanitizedOccasions.add(occasionId);
    }
  } catch (error) {
    if (!(error instanceof JudgmentInputError)) throw error;
    collectionProblem = error.problem;
  }
  return { collectionProblem, problems, sanitizedOccasions };
}

export type StoredReadingKind = 'gifts' | 'openItems' | 'acknowledgements';

/**
 * Proofs belong only to deep-frozen copies this owner created. Mutable caller
 * identities are never keys, and a failed write never installs the staged copy.
 */
export class StoredRecordAdmissionOwner {
  private readonly records = {
    gifts: new WeakMap<object, JudgmentInputProblem | null>(),
    openItems: new WeakMap<object, JudgmentInputProblem | null>(),
    acknowledgements: new WeakMap<object, JudgmentInputProblem | null>(),
  };
  private readonly collections = new WeakMap<object, JudgmentInputProblem | null>();

  own<T extends object>(kind: StoredReadingKind, source: readonly T[]): T[] {
    requireShape(Array.isArray(source) && Object.getPrototypeOf(source) === Array.prototype && Object.getOwnPropertySymbols(source).length === 0);
    const descriptors = Object.getOwnPropertyDescriptors(source as object);
    requireShape(!Object.hasOwn(descriptors, 'constructor') && Object.values(descriptors).every(descriptor => 'value' in descriptor));
    const length: unknown = descriptors.length?.value;
    requireShape(typeof length === 'number' && Number.isSafeInteger(length) && length >= 0);
    const extras: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const index = Number(key);
      if (key !== 'length' && !(Number.isInteger(index) && index >= 0 && index < length && String(index) === key)) extras[key] = descriptor.value as unknown;
    }
    // JSON arrays cannot persist named extras. Refuse protected extras before
    // producing slots that a batch writer could otherwise silently sanitize.
    const inheritedProblem = this.collections.get(source);
    if (inheritedProblem) throw new JudgmentInputError(inheritedProblem);
    snapshotJudgmentInput(extras);
    const owned: T[] = [];
    const proofs = this.records[kind];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      requireShape(descriptor !== undefined && 'value' in descriptor);
      const record: unknown = descriptor.value;
      requireShape(record !== null && typeof record === 'object' && !Array.isArray(record));
      if (proofs.has(record)) { owned.push(record as T); continue; }
      // Match structuredClone's ordinary object prototypes while owning every
      // nested value. Admission capture rejects accessors before any clone can run them.
      const copy = structuredClone(captureOwnedJson(record)) as T;
      const freeze = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      };
      freeze(copy);
      proofs.set(copy, storedEvidenceProblem(kind, [copy]) ?? null);
      owned.push(copy);
    }
    Object.freeze(owned);
    this.collections.set(owned, null);
    return owned;
  }

  giftAdmission(source: readonly GiftRecord[]): StoredGiftAdmission {
    requireShape(this.collections.has(source));
    const problems = new Map<string, JudgmentInputProblem>();
    let collectionProblem = this.collections.get(source) ?? undefined;
    for (const record of source) {
      requireShape(this.records.gifts.has(record));
      if (!text(record.occasionId)) { collectionProblem = 'unsupported-input'; continue; }
      const problem = this.records.gifts.get(record);
      if (problem) problems.set(record.occasionId, problem);
    }
    return { collectionProblem, problems, sanitizedOccasions: new Set() };
  }

  collectionProblem(kind: 'openItems' | 'acknowledgements', source: readonly object[]): JudgmentInputProblem | undefined {
    requireShape(this.collections.has(source));
    const collectionProblem = this.collections.get(source);
    if (collectionProblem) return collectionProblem;
    for (const record of source) {
      requireShape(this.records[kind].has(record));
      const problem = this.records[kind].get(record);
      if (problem) return problem;
    }
    return undefined;
  }
}
