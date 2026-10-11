/** Native prepared settings source restriction; unrelated JSON fields may still merge. */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { observeImportFile, type ImportFileObservation } from './prepared-import.js';
import { readDotPath } from './shared-config-tier.js';

function physicalFile(path: string): string | null {
  const link = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!link) return null;
  const target = statSync(path, { bigint: true });
  if (!target.isFile()) throw new Error('Prepared settings target is unavailable.');
  return [realpathSync(path), target.dev, target.ino, link.dev, link.ino,
    ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':');
}
function valueProjection(raw: string | null, key: string): string {
  const value: unknown = raw === null ? {} : JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prepared settings target is unavailable.');
  return JSON.stringify(readDotPath(value, key));
}
function assertParents(parents: ImportFileObservation['parents']): void {
  for (const parent of parents) {
    const link = lstatSync(parent.path, { bigint: true }), target = statSync(parent.path, { bigint: true });
    if (realpathSync(parent.path) !== parent.target || [target.dev, target.ino, link.dev, link.ino,
      ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':') !== parent.identity) throw new Error('Prepared settings parent changed.');
  }
}

/** Private mutable observations advance only from the native declared publication. */
export class PreparedSettingsTarget {
  private observation: ImportFileObservation;
  private identity: string | null;
  private readonly parents = new Map<string, ImportFileObservation['parents'][number]>();
  private readonly keys = new Map<string, string>();
  constructor(readonly path: string, keys: readonly string[]) {
    this.observation = observeImportFile(path); this.identity = physicalFile(path);
    for (const parent of this.observation.parents) this.parents.set(parent.path, parent);
    for (const key of keys) this.keys.set(key, valueProjection(this.observation.raw, key));
    this.assertCurrent();
  }
  private assertRoute(): void {
    assertParents([...this.parents.values()]);
    if (this.observation.absentParent) {
      let parent = dirname(this.path);
      while (parent !== this.observation.absentParent.path) {
        const entry = lstatSync(parent, { throwIfNoEntry: false });
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Prepared settings parent changed.');
        const next = dirname(parent); if (next === parent) throw new Error('Prepared settings parent changed.'); parent = next;
      }
    }
  }
  assertCurrent(): void {
    this.assertRoute();
    const identity = physicalFile(this.path), current = observeImportFile(this.path);
    // A formerly absent file may acquire unrelated content in this owner's
    // same physical directory. Existing targets and aliases retain identity.
    if (this.identity !== null && identity !== this.identity) throw new Error('Prepared settings target changed.');
    if (this.identity === null && lstatSync(this.path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Prepared settings target changed.');
    for (const [key, expected] of this.keys) if (valueProjection(current.raw, key) !== expected) throw new Error('Prepared settings source key changed.');
    this.assertRoute(); assertParents(current.parents);
    // New ordinary directories or an unrelated new file can only tighten the
    // captured source. Subsequent replacement cannot restore this lease.
    for (const parent of current.parents) if (!this.parents.has(parent.path)) this.parents.set(parent.path, parent);
    this.identity ??= identity;
  }
  acceptPublication(key: string, present: boolean, value: unknown): void {
    this.assertRoute();
    const next = observeImportFile(this.path);
    const expected = JSON.stringify(present ? { present: true, value } : { present: false });
    if (valueProjection(next.raw, key) !== expected) throw new Error('Prepared settings publication changed.');
    for (const [other, previous] of this.keys) if (other !== key && valueProjection(next.raw, other) !== previous) throw new Error('Prepared companion source changed.');
    this.assertRoute(); assertParents(next.parents);
    for (const parent of next.parents) if (!this.parents.has(parent.path)) this.parents.set(parent.path, parent);
    this.identity = physicalFile(this.path); this.observation = next; this.keys.set(key, expected);
  }
}
