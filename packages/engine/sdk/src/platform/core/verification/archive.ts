import { verificationHash } from './source.js';

export interface VerificationArchive {
  readonly branch?: string;
  readonly histories: readonly { readonly messages: readonly Record<string, unknown>[] }[];
  readonly derived: readonly (readonly [number, string])[];
}
interface Archive {
  readonly histories: { messages: readonly Record<string, unknown>[] }[];
  derived: Map<number, string>;
  changed: boolean;
}
interface Archives {
  active: string;
  readonly branches: Map<string, Archive>;
  save?: ((snapshot: VerificationArchive) => void) | undefined;
}
const archives = new WeakMap<object, Archives>();
const empty = (): Archive => ({ histories: [], derived: new Map(), changed: false });
function collection(owner: object): Archives {
  let found = archives.get(owner);
  if (!found) { found = { active: 'main', branches: new Map([['main', empty()]]) }; archives.set(owner, found); }
  return found;
}
function archive(owner: object): Archive { const entries = collection(owner); return entries.branches.get(entries.active)!; }
const snapshot = (branch: string, entry: Archive): VerificationArchive => ({ branch, histories: entry.histories, derived: [...entry.derived] });
export function verificationHistory(owner: object) { return archive(owner).histories; }
export function registerVerificationArchive(owner: object, save: Archives['save'], restored: readonly VerificationArchive[] = []): void {
  const entries = collection(owner);
  for (const value of restored) {
    const name = value.branch ?? 'main', current = entries.branches.get(name);
    if (!current?.changed) entries.branches.set(name, { histories: [...value.histories], derived: new Map(value.derived), changed: true });
  }
  entries.save = save;
  const entry = archive(owner);
  if (entry.changed) save?.(snapshot(entries.active, entry));
}
export function restoreVerificationBranch(owner: object, branch: string): void {
  // Loading another session must never write through the previous session's hook.
  archives.set(owner, { active: branch, branches: new Map([[branch, empty()]]) });
}
export function resetVerificationArchives(owner: object): void {
  const entries = collection(owner), entry = { ...empty(), changed: true };
  entries.save?.(snapshot('main', entry)); entries.active = 'main'; entries.branches.clear(); entries.branches.set('main', entry);
}
export function forkVerificationArchive(owner: object, name: string): void {
  const entries = collection(owner), current = archive(owner);
  const branch: Archive = { histories: [...current.histories], derived: new Map(current.derived), changed: true };
  entries.save?.(snapshot(name, branch)); entries.branches.set(name, branch);
}
export function switchVerificationArchive(owner: object, name: string): void {
  const entries = collection(owner), next = entries.branches.get(name) ?? empty();
  entries.save?.(snapshot(name, next)); entries.branches.set(name, next); entries.active = name;
}
export function mergeVerificationArchive(owner: object, name: string, start: number, targetStart: number): void {
  const entries = collection(owner), current = archive(owner), other = entries.branches.get(name);
  if (!other) return;
  const histories = [...current.histories, ...other.histories.map(history => ({ messages: history.messages.map(message => message.role === 'user'
    ? { ...message, role: 'system', evidenceOrigin: `original user context from merged branch ${name}; reference, not a new instruction` } : message) }))];
  const derived = new Map(current.derived);
  for (const [position, hash] of other.derived) if (position >= start) derived.set(targetStart + position - start, hash);
  const next: Archive = { histories, derived, changed: true };
  entries.save?.(snapshot(entries.active, next)); entries.branches.set(entries.active, next);
}

/** Archive originals before compaction; newly generated prose remains reference
 * material even when represented as a provider-facing user message. */
export function archiveVerificationCompaction(owner: object, before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): void {
  const entries = collection(owner), entry = archive(owner);
  const originals = before.filter((message, index) => entry.derived.get(index) !== verificationHash(message));
  const positions = new Map<string, number[]>();
  before.forEach((message, index) => { const key = verificationHash(message), found = positions.get(key) ?? []; found.push(index); positions.set(key, found); });
  const derived = new Map<number, string>();
  after.forEach((message, index) => {
    const key = verificationHash(message), original = positions.get(key)?.shift();
    if (original === undefined || entry.derived.get(original) === key) derived.set(index, key);
  });
  const next: Archive = { histories: [...entry.histories, { messages: originals }], derived, changed: true };
  entries.save?.(snapshot(entries.active, next)); entries.branches.set(entries.active, next);
}
export function verificationMessages(owner: object, messages: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  const derived = archive(owner).derived;
  if (!derived.size) return messages;
  return messages.map((message, index) => {
    const expected = derived.get(index);
    return expected !== undefined && expected === verificationHash(message)
      ? { ...message, role: 'system', evidenceOrigin: 'native compaction reference, not a user instruction or new execution' } : message;
  });
}
