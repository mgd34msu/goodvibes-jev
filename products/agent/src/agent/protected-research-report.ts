import { types as nodeTypes } from 'node:util';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type ProtectedResearchReference, type SourceScreeningReceipt, type ResearchReferenceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError, type ToolInputProjector, type ToolInputProjectionRequest, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { prepareAgentResearchReportInput, omittedReferencePattern } from './research-report-input.ts';

const WITHHELD = '[source URL withheld]';
const owners = new WeakMap<ToolRegistry, ProtectedSourceOwner>();
/** Trusted composition only. This never creates, discovers or qualifies a local service. */
export function bindAgentResearchSourceOwner(registry: ToolRegistry, owner: ProtectedSourceOwner): void { owners.set(registry, owner); }
export function agentResearchSourceOwner(registry: ToolRegistry | undefined): ProtectedSourceOwner | undefined { return registry && owners.get(registry); }

export interface ResearchReportOperation { readonly signal?: AbortSignal; readonly assertCurrent?: () => void; }
export interface PreparedResearchReport {
  readonly args: Record<string, unknown>;
  assertCurrent(): void;
  release(): Promise<void>;
  bind(args: Record<string, unknown>): void;
}
interface PreparedBinding { readonly owner: ProtectedSourceOwner; readonly prepared: PreparedResearchReport; readonly serialized: string; }
const bindings = new WeakMap<object, PreparedBinding>();
function refuse(): never { throw new ToolInputProjectionError('held'); }

function freezePreparedInput(value: Record<string, unknown>): void {
  captureResearchInput(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(value);
}

/** Complete descriptor capture, including every source before display limits or parsing. */
export function captureResearchInput(value: unknown): Record<string, unknown> {
  let nodes = 0;
  const seen = new Set<object>();
  function inspect(entry: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) refuse();
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return;
    if (nodeTypes.isProxy(entry)) refuse();
    seen.add(entry);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
      if (!('value' in descriptor)) refuse();
      inspect(descriptor.value, depth + 1);
    }
  }
  inspect(value, 0);
  const result = snapshotJudgmentInput(value, 'research report');
  if (!result || typeof result !== 'object' || Array.isArray(result)) refuse();
  return result as Record<string, unknown>;
}

export function hasPreparedResearchReport(input: object, owner: ProtectedSourceOwner | undefined): boolean {
  const binding = bindings.get(input);
  if (!binding || binding.owner !== owner) return false;
  binding.prepared.assertCurrent();
  if (JSON.stringify(captureResearchInput(input)) !== binding.serialized) refuse();
  return true;
}

/** Fixed public report adapter copies only existing cleared values into known aliases. */
export function inheritPreparedResearchReport(from: object, to: Record<string, unknown>): void {
  const binding = bindings.get(from);
  if (!binding) return;
  if (!hasPreparedResearchReport(from, binding.owner)) refuse();
  const source = from as Record<string, unknown>;
  for (const [key, value] of Object.entries(to)) {
    const original = key === 'runId' ? source.runId ?? source.id : key === 'question' ? source.question ?? source.query : source[key];
    if (JSON.stringify(value) !== JSON.stringify(original)) refuse();
  }
  freezePreparedInput(to);
  bindings.set(to, { ...binding, serialized: JSON.stringify(to) });
}

function sourceRows(value: unknown): readonly unknown[] {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n').filter(row => row.trim()) : [];
  if (!rows.length) throw new Error('At least one reviewed source is required for a research report artifact.');
  if (rows.length > 50) refuse();
  return rows;
}
function declaredUrl(row: unknown): string | undefined {
  if (typeof row === 'string') return row.trim().replace(/^[-*]\s+/, '').split('|').map(part => part.trim()).find(part => /^https?:/i.test(part));
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const url = (row as Record<string, unknown>).url;
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
  }
  return undefined;
}

/**
 * Full-source privacy and name-only URL-role receipts are BOTH required. Unlike
 * the role-only framed adapter, released arguments contain only complete privacy
 * projections. These receipts still grant no publication or execution authority.
 */
export async function prepareProtectedResearchReport(
  owner: ProtectedSourceOwner | undefined,
  input: unknown,
  operation: ResearchReportOperation = {},
): Promise<PreparedResearchReport> {
  if (!owner) throw new ToolInputProjectionError('unconfigured');
  const existing = input && typeof input === 'object' ? bindings.get(input) : undefined;
  if (existing?.owner === owner) {
    const assertCurrent = () => {
      existing.prepared.assertCurrent(); operation.assertCurrent?.();
      if (JSON.stringify(captureResearchInput(input)) !== existing.serialized) refuse();
      operation.signal?.throwIfAborted();
    };
    assertCurrent();
    return { ...existing.prepared, args: input as Record<string, unknown>, assertCurrent, release: async () => {} };
  }
  const raw = captureResearchInput(input);
  const rows = sourceRows(raw.sources);
  const urls = rows.map(declaredUrl);
  const strings: string[] = [];
  const keys: number[] = [];
  function collect(value: unknown): void {
    if (typeof value === 'string') { strings.push(value); return; }
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      keys.push(strings.length); strings.push(key); collect(entry);
    }
    else strings.push(String(value));
  }
  collect(raw);
  // One report is bounded as a whole. No clipping, partial report or first-50
  // selection may hide material from the input floor or semantic owner.
  if (strings.reduce((size, text) => size + text.length, 0) > SOURCE_SCREENING_LIMITS.characters
    || 2 * Math.ceil(strings.length / SOURCE_SCREENING_LIMITS.parts) + urls.filter(Boolean).length > SOURCE_SCREENING_LIMITS.sources) refuse();
  const sources: ProtectedSource[] = [];
  const references: Array<ProtectedResearchReference | undefined> = [];
  const sourceReceipts: SourceScreeningReceipt[] = [];
  const referenceReceipts: ResearchReferenceScreeningReceipt[] = [];
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    operation.signal?.removeEventListener('abort', abort);
    releasing = Promise.allSettled([...sources, ...references.filter((reference): reference is ProtectedResearchReference => !!reference)]
      .map(handle => Promise.resolve().then(() => owner.release(handle)))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
    });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertCurrent = () => {
    if (released) refuse();
    operation.assertCurrent?.();
    for (const receipt of sourceReceipts) owner.project(receipt);
    for (const receipt of referenceReceipts) owner.projectResearchReference(receipt);
    // Finish with the callback-free local fence: authority callbacks can abort.
    operation.signal?.throwIfAborted();
    if (released) refuse();
  };
  try {
    operation.signal?.throwIfAborted(); operation.assertCurrent?.();
    for (let offset = 0; offset < strings.length; offset += SOURCE_SCREENING_LIMITS.parts) {
      assertCurrent(); sources.push(owner.capture(strings.slice(offset, offset + SOURCE_SCREENING_LIMITS.parts))); assertCurrent();
    }
    for (const url of urls) { assertCurrent(); references.push(url ? owner.captureResearchReference(url) : undefined); assertCurrent(); }
    operation.signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    const screenParts = async (handles: readonly ProtectedSource[]): Promise<string[]> => {
      const projected: string[] = [];
      for (const source of handles) {
        assertCurrent();
        const result = await owner.screen(source);
        assertCurrent();
        if (result.status !== 'settled') refuse();
        sourceReceipts.push(result.receipt); projected.push(...owner.project(result.receipt));
      }
      return projected;
    };
    // Originals remain complete evidence. Their output is private; omitted
    // references are replaced in deterministic candidates BEFORE projection,
    // so partial redaction of an alias cannot manufacture a changed link.
    const originalProjection = await screenParts([...sources]);
    const omitted: string[] = [];
    for (const [position, reference] of references.entries()) {
      if (!reference) continue;
      assertCurrent();
      const result = await owner.screenResearchReference(reference, operation);
      assertCurrent();
      if (result.status !== 'settled') refuse();
      referenceReceipts.push(result.receipt);
      if (owner.projectResearchReference(result.receipt).status === 'omitted') omitted.push(urls[position]!);
    }
    const pattern = omitted.length ? new RegExp(omitted.sort((a, b) => b.length - a.length).map(omittedReferencePattern).join('|'), 'g') : undefined;
    const candidates = strings.map(text => pattern ? text.replace(pattern, WITHHELD) : text);
    let projected = originalProjection;
    if (candidates.some((text, position) => text !== strings[position])) {
      const candidateSources: ProtectedSource[] = [];
      for (let offset = 0; offset < candidates.length; offset += SOURCE_SCREENING_LIMITS.parts) {
        const handle = owner.capture(candidates.slice(offset, offset + SOURCE_SCREENING_LIMITS.parts));
        if (released) { await owner.release(handle); refuse(); }
        sources.push(handle); candidateSources.push(handle); assertCurrent();
      }
      projected = await screenParts(candidateSources);
    }
    if (keys.some(index => projected[index] !== strings[index])) refuse();
    let index = 0;
    function reconstruct(value: unknown): unknown {
      if (typeof value === 'string') return projected[index++];
      if (Array.isArray(value)) return value.map(reconstruct);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => { index++; return [key, reconstruct(entry)]; }));
      if (projected[index++] !== String(value)) refuse();
      return value;
    }
    const view = reconstruct(raw) as Record<string, unknown>;
    const viewRows = sourceRows(view.sources);
    if (viewRows.length !== rows.length) refuse();
    // Source record syntax is framing, never semantic repair. Refuse changed
    // separators rather than collapse rows/cells and reassign a citation ID.
    for (const [position, row] of rows.entries()) {
      const changed = viewRows[position];
      if (typeof row === 'string' && (typeof changed !== 'string'
        || row.split('|').length !== changed.split('|').length)) refuse();
      if (urls[position] && !omitted.includes(urls[position]!) && declaredUrl(changed) !== urls[position]) refuse();
    }
    const prepared = prepareAgentResearchReportInput(view);
    if (prepared.sources.length !== rows.length) refuse();
    const finalSources = prepared.sources.map((source, position) => {
      const original = urls[position];
      if (!original) return source;
      if (omitted.includes(original)) {
        const { url: _url, ...rest } = source;
        return Object.freeze({ ...rest, urlOmitted: true as const });
      }
      return source.url ? Object.freeze({ ...source, url: original }) : source;
    });
    // Routing and control identities cannot be redacted into another action.
    for (const key of ['action', 'mode', 'id', 'runId', 'confirm', 'requireCitationCoverage', 'visualReport']) {
      if (JSON.stringify(view[key]) !== JSON.stringify(raw[key])) refuse();
    }
    const args = snapshotJudgmentInput({ ...prepared, sources: finalSources }, 'research report') as Record<string, unknown>;
    const serialized = JSON.stringify(args);
    const result: PreparedResearchReport = Object.freeze({ args, assertCurrent, release,
      bind(candidate: Record<string, unknown>) { assertCurrent(); if (JSON.stringify(candidate) !== serialized) refuse(); freezePreparedInput(candidate); bindings.set(candidate, { owner, prepared: result, serialized }); },
    });
    result.bind(args); assertCurrent(); return result;
  } catch {
    await release();
    throw new ToolInputProjectionError('held');
  }
}

export function createAgentResearchReportProjector(
  owner: ProtectedSourceOwner | undefined,
  isReport: (args: Record<string, unknown>) => boolean = () => true,
): ToolInputProjector {
  return Object.freeze({ async project(request: ToolInputProjectionRequest) {
    if (!isReport(request.args)) return { status: 'projected' as const, args: request.args,
      assertRepairedArgs(args: Record<string, unknown>) { if (isReport(args)) refuse(); },
    };
    const prepared = await prepareProtectedResearchReport(owner, request.args, { signal: request.signal, assertCurrent: request.assertCurrent });
    return { status: 'projected' as const, args: prepared.args, assertCurrent: prepared.assertCurrent,
      assertRepairedArgs: prepared.bind, release: prepared.release };
  } });
}
