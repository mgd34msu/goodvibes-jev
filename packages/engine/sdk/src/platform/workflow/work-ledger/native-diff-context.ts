/** Browser-safe selectors and exact quoted diff evidence. Neither conveys authority. */
import { literal, number, strictObject, string, union, type z } from 'zod/v4';

export const NATIVE_SELECTED_DIFF_MAX_BYTES = 65_536;
export const NATIVE_SELECTED_DIFF_SOURCE_MAX_BYTES = 4_194_304;
const id = string().min(1).max(200);
const selector = { revision: string().regex(/^[a-f0-9]{64}$/), fileIndex: number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), hunkIndex: number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const sessionSelector = strictObject({ kind: literal('session'), ...selector });
const workspaceSelector = strictObject({ kind: literal('workspace'), baselineId: id, ...selector });
export const nativeSelectedDiffSelectorSchema = union([sessionSelector, workspaceSelector]);
export type NativeSelectedDiffSelector = Readonly<z.infer<typeof nativeSelectedDiffSelectorSchema>>;
export class NativeSelectedDiffError extends Error {
  constructor(readonly code: 'stale' | 'missing' | 'unsupported' | 'oversize') {
    super(`Native selected diff: ${code}`); this.name = 'NativeSelectedDiffError';
  }
}

/** SHA-256 of the exact full unified diff returned by the checkpoint read. */
export async function nativeSelectedDiffRevision(unifiedDiff: string): Promise<string> {
  const bytes = new TextEncoder().encode(unifiedDiff);
  if (bytes.byteLength > NATIVE_SELECTED_DIFF_SOURCE_MAX_BYTES) throw new NativeSelectedDiffError('oversize');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Select raw file headers plus one complete hunk; never slice lines or synthesize headers. */
export function selectNativeDiffHunk(unifiedDiff: string, fileIndex: number, hunkIndex: number): string {
  if (![fileIndex, hunkIndex].every(value => Number.isSafeInteger(value) && value >= 0)) throw new NativeSelectedDiffError('missing');
  if (new TextEncoder().encode(unifiedDiff).byteLength > NATIVE_SELECTED_DIFF_SOURCE_MAX_BYTES) throw new NativeSelectedDiffError('oversize');
  const files = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);
  if (!files.length || files.some(file => !file.startsWith('diff --git '))) throw new NativeSelectedDiffError('unsupported');
  const file = files[fileIndex];
  if (file === undefined) throw new NativeSelectedDiffError('missing');
  const lines = file.match(/[^\n]*(?:\n|$)/g)!.filter(Boolean);
  const clean = (line: string) => line.replace(/\r?\n$/, '');
  const first = lines.findIndex(line => line.startsWith('@@'));
  if (first < 0) throw new NativeSelectedDiffError('unsupported');
  const headers = lines.slice(0, first);
  if (headers.filter(line => line.startsWith('--- ')).length !== 1 || headers.filter(line => line.startsWith('+++ ')).length !== 1) throw new NativeSelectedDiffError('unsupported');
  const hunks: string[] = [];
  let index = first;
  while (index < lines.length) {
    const start = index;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(clean(lines[index++]!));
    if (!match) throw new NativeSelectedDiffError('unsupported');
    let oldRemaining = Number(match[2] ?? 1), newRemaining = Number(match[4] ?? 1);
    if (![oldRemaining, newRemaining, Number(match[1]), Number(match[3])].every(Number.isSafeInteger)) throw new NativeSelectedDiffError('unsupported');
    let body = false;
    while (index < lines.length && !lines[index]!.startsWith('@@')) {
      const line = lines[index++]!;
      if (clean(line) === '\\ No newline at end of file' && body) continue;
      if (line.startsWith(' ')) { oldRemaining--; newRemaining--; }
      else if (line.startsWith('-')) oldRemaining--;
      else if (line.startsWith('+')) newRemaining--;
      else throw new NativeSelectedDiffError('unsupported');
      body = true;
      if (oldRemaining < 0 || newRemaining < 0) throw new NativeSelectedDiffError('unsupported');
    }
    if (!body || oldRemaining !== 0 || newRemaining !== 0) throw new NativeSelectedDiffError('unsupported');
    hunks.push(lines.slice(start, index).join(''));
  }
  const hunk = hunks[hunkIndex];
  if (hunk === undefined) throw new NativeSelectedDiffError('missing');
  const result = headers.join('') + hunk;
  if (new TextEncoder().encode(result).byteLength > NATIVE_SELECTED_DIFF_MAX_BYTES) throw new NativeSelectedDiffError('oversize');
  return result;
}

const unifiedDiff = string().min(1).max(NATIVE_SELECTED_DIFF_MAX_BYTES);
export const nativeSelectedDiffContextSchema = union([
  sessionSelector.extend({ unifiedDiff, provenance: strictObject({ kind: literal('session'), sessionId: id, baselineCheckpointId: id, latestCheckpointId: id }) }),
  workspaceSelector.extend({ unifiedDiff, provenance: strictObject({ kind: literal('workspace'), baselineId: id, to: literal('WORKING') }) }),
]).refine(value => {
  try { return selectNativeDiffHunk(value.unifiedDiff, 0, 0) === value.unifiedDiff && (value.kind !== 'workspace' || value.baselineId === value.provenance.baselineId); }
  catch { return false; }
}, 'Selected diff must retain one complete exact hunk and matching provenance');
export type NativeSelectedDiffContext = Readonly<z.infer<typeof nativeSelectedDiffContextSchema>>;
export function nativeSelectedDiffSelector(context: NativeSelectedDiffContext): NativeSelectedDiffSelector {
  return Object.freeze({ kind: context.kind, ...(context.kind === 'workspace' ? { baselineId: context.baselineId } : {}), revision: context.revision, fileIndex: context.fileIndex, hunkIndex: context.hunkIndex }) as NativeSelectedDiffSelector;
}

/** Reject accessors before parsing and detach host evidence from all caller references. */
export function captureNativeSelectedDiffContext(value: unknown): NativeSelectedDiffContext {
  const seen = new Set<object>();
  function data(input: unknown): void {
    if (typeof input === 'string' || (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0)) return;
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || seen.has(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string')) throw new NativeSelectedDiffError('unsupported');
    seen.add(input);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
      if (!('value' in descriptor) || descriptor.value === input) throw new NativeSelectedDiffError('unsupported');
      data(descriptor.value);
    }
    seen.delete(input);
  }
  data(value);
  const parsed = nativeSelectedDiffContextSchema.parse(value);
  Object.freeze(parsed.provenance);
  return Object.freeze(parsed);
}
