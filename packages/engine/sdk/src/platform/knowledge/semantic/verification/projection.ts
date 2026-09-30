import { createHash } from 'node:crypto';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import { isGeneratedKnowledgeSource } from '../../generated-projections.js';
import type { KnowledgeNodeRecord } from '../../types.js';
import { KnowledgeGeneratedFactSupportHeldError as Held, type GeneratedFactSupportInput } from './types.js';

export function supportHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function freezeSupport<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSupport(child);
    Object.freeze(value);
  }
  return value;
}
/** Structural inspection before any property reads, JSON conversion or privacy scan. */
function assertPlainSnapshot(value: unknown): void {
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) throw new JudgmentInputError('unsupported-input');
    if (typeof entry === 'string') { chars += entry.length; if (chars > 1_000_000) throw new JudgmentInputError('unsupported-input'); return; }
    if (entry === undefined || entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || ancestors.has(entry)) throw new JudgmentInputError('unsupported-input');
    const proto: unknown = Object.getPrototypeOf(entry);
    if (Array.isArray(entry) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new JudgmentInputError('unsupported-input');
    if (Object.getOwnPropertySymbols(entry).length) throw new JudgmentInputError('unsupported-input');
    ancestors.add(entry);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (descriptor.get || descriptor.set) throw new JudgmentInputError('unsupported-input');
      if (key !== 'length' && descriptor.enumerable) visit(descriptor.value, depth + 1);
    }
    ancestors.delete(entry);
  }
  visit(value, 0);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function optionalText(value: unknown): void { if (value !== undefined && typeof value !== 'string') throw new Held('malformed'); }
function stringArray(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Held('malformed');
  for (let index = 0; index < value.length; index++) if (typeof value[index] !== 'string') throw new Held('malformed');
}
function sameSpace(value: unknown, spaceId: string): void {
  if (!record(value) || !record(value.metadata)) throw new Held('malformed');
  for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
    const declared = value.metadata[key];
    if (declared !== undefined && (!text(declared) || declared.trim() !== spaceId)) throw new Held('foreign-space');
  }
  if (getKnowledgeSpaceId(value) !== spaceId) throw new Held('foreign-space');
}
function subjectProjection(subject: KnowledgeNodeRecord) {
  if (!text(subject.id) || !text(subject.title) || !text(subject.kind)) throw new Held('malformed');
  if (subject.status !== 'active' && subject.status !== 'draft') throw new Held('stale');
  stringArray(subject.aliases); optionalText(subject.summary);
  const identity: Record<string, string> = {};
  for (const key of ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind']) {
    optionalText(subject.metadata[key]);
    if (typeof subject.metadata[key] === 'string') identity[key] = subject.metadata[key];
  }
  return { id: subject.id, kind: subject.kind, title: subject.title, aliases: [...subject.aliases], ...(subject.summary === undefined ? {} : { summary: subject.summary }), identity };
}
const CLAIM_KEYS = new Set(['id', 'kind', 'title', 'summary', 'value', 'evidence', 'labels', 'aliases', 'subject', 'targetHints']);
const HINT_KEYS = new Set(['id', 'kind', 'title']);

/** Produces only explicit evidence and identity fields; arbitrary metadata never leaves this boundary. */
export function projectSupportInput(input: GeneratedFactSupportInput) {
  assertPlainSnapshot(input);
  if (!record(input) || !text(input.spaceId) || input.spaceId !== input.spaceId.trim()
    || !record(input.source) || !record(input.claim) || !Array.isArray(input.subjects)) throw new Held('malformed');
  const { source, extraction, claim, spaceId } = input;
  sameSpace(source, spaceId);
  if (!record(extraction)) throw new Held('missing-evidence');
  sameSpace(extraction, spaceId);
  for (const subject of input.subjects) {
    if (!record(subject)) throw new Held('malformed');
    sameSpace(subject, spaceId);
  }
  if (!text(source.sourceType) || !text(source.id) || !text(extraction.id) || extraction.sourceId !== source.id) throw new Held('malformed');
  if (!Number.isFinite(source.updatedAt) || !Number.isFinite(extraction.updatedAt)) throw new Held('malformed');
  if (source.status !== 'indexed' && source.status !== 'pending') throw new Held('stale');
  if (isGeneratedKnowledgeSource(source)) throw new Held('missing-evidence');
  if (!text(claim.id) || !text(claim.kind) || !text(claim.title) || Object.keys(claim).some((key) => !CLAIM_KEYS.has(key))) throw new Held('malformed');
  for (const value of [claim.summary, claim.subject, source.title, source.url, source.sourceUri, source.canonicalUri, extraction.title, extraction.summary, extraction.excerpt]) optionalText(value);
  stringArray(extraction.sections);
  for (const values of [claim.labels, claim.aliases]) if (values !== undefined) stringArray(values);
  if (claim.targetHints !== undefined && Array.isArray(claim.targetHints)) {
    for (let index = 0; index < claim.targetHints.length; index++) if (!Object.hasOwn(claim.targetHints, index)) throw new Held('malformed');
  }
  if (claim.targetHints !== undefined && (!Array.isArray(claim.targetHints) || claim.targetHints.some((hint) => {
    if (typeof hint === 'string') return false;
    return !record(hint) || Object.keys(hint).some((key) => !HINT_KEYS.has(key)) || !text(hint.id) || !text(hint.kind) || !text(hint.title);
  }))) throw new Held('malformed');
  if (!record(extraction.structure) || !record(extraction.metadata)) throw new Held('malformed');
  // Established extractor text paths only. Never copy arbitrary structure/metadata blobs.
  const texts: Record<string, string> = {};
  const containers: readonly [string, unknown][] = [
    ['structure', extraction.structure], ['structure.structure', extraction.structure.structure],
    ['structure.metadata', extraction.structure.metadata], ['metadata', extraction.metadata],
  ];
  for (const [path, container] of containers) {
    if (!record(container)) continue;
    for (const key of ['text', 'content', 'searchText']) {
      const value = container[key];
      optionalText(value);
      if (typeof value === 'string') texts[`${path}.${key}`] = value;
    }
  }
  if (![extraction.excerpt, ...extraction.sections, ...Object.values(texts)].some(text)) throw new Held('missing-evidence');
  const sourceState = {
    id: source.id, sourceType: source.sourceType,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.url === undefined ? {} : { url: source.url }),
    ...(source.sourceUri === undefined ? {} : { sourceUri: source.sourceUri }),
    ...(source.canonicalUri === undefined ? {} : { canonicalUri: source.canonicalUri }),
  };
  const extractionState = {
    id: extraction.id, sourceId: extraction.sourceId,
    ...(extraction.title === undefined ? {} : { title: extraction.title }),
    ...(extraction.summary === undefined ? {} : { summary: extraction.summary }),
    ...(extraction.excerpt === undefined ? {} : { excerpt: extraction.excerpt }),
    sections: extraction.sections, texts,
  };
  const subjects = input.subjects.map((subject) => ({ state: subjectProjection(subject), hash: supportHash(subject) }));
  const state = { spaceId, claim, source: sourceState, extraction: extractionState, subjects: subjects.map((subject) => subject.state) };
  // Called for EVERY selected input before the reader sends ANY request, without clipping.
  assertJudgmentInput(state);
  const fields: { name: string; value: JsonValue }[] = [];
  for (const name of ['kind', 'title', 'summary', 'value', 'evidence', 'subject'] as const) {
    const value = claim[name];
    if (value !== undefined) fields.push({ name, value: JSON.parse(JSON.stringify(value)) as JsonValue });
  }
  for (const name of ['labels', 'aliases', 'targetHints'] as const) {
    claim[name]?.forEach((value, index) => fields.push({ name: `${name}[${index}]`, value: JSON.parse(JSON.stringify(value)) as JsonValue }));
  }
  // Detach the request/plan from caller-owned objects before the first await.
  const snapshot = JSON.parse(JSON.stringify({ state, fields, subjects, claim })) as {
    state: JsonValue; fields: typeof fields; subjects: { state: ReturnType<typeof subjectProjection>; hash: string }[]; claim: typeof claim;
  };
  return freezeSupport({ ...snapshot, spaceId, claimId: claim.id, claimHash: supportHash(claim), sourceId: source.id,
    sourceHash: supportHash(source), extractionId: extraction.id, extractionHash: supportHash(extraction),
    extractionUpdatedAt: extraction.updatedAt, evidenceHash: supportHash(extractionState) });
}
export type ProjectedSupportInput = ReturnType<typeof projectSupportInput>;
