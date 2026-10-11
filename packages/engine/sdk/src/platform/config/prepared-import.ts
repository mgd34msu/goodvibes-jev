import { lstatSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname } from 'node:path';

/** Private captured bytes. This record must never become admission evidence. */
export interface ImportFileObservation {
  readonly stamp: string;
  readonly raw: string | null;
  readonly absentParent?: Readonly<{ path: string; target: string; identity: string }>;
  readonly parents: readonly Readonly<{ path: string; target: string; identity: string }>[];
}
function parentIdentities(path: string): ImportFileObservation['parents'] {
  const result: { path: string; target: string; identity: string }[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const link = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (link) {
      const target = statSync(parent, { bigint: true });
      result.push({ path: parent, target: realpathSync(parent), identity: [target.dev, target.ino, link.dev, link.ino,
        ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':') });
    }
    if (dirname(parent) === parent) break;
  }
  return Object.freeze(result.map(entry => Object.freeze(entry)));
}
export function observeImportFile(path: string): ImportFileObservation {
  const identity = (value: BigIntStats) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
  const parents = parentIdentities(path);
  try {
    const link = lstatSync(path, { bigint: true }), before = statSync(path, { bigint: true }), target = realpathSync(path);
    const raw = readFileSync(path, 'utf8');
    const after = statSync(path, { bigint: true }), nextLink = lstatSync(path, { bigint: true });
    if (identity(before) !== identity(after) || identity(link) !== identity(nextLink) || realpathSync(path) !== target) throw new Error('Import file changed.');
    const result = { stamp: `${target}:${identity(after)}:${identity(nextLink)}:${raw}`, raw, parents };
    assertParentsCurrent(parents); return result;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error('Import file is unavailable.');
    let parent = dirname(path);
    while (!lstatSync(parent, { throwIfNoEntry: false })) {
      const next = dirname(parent); if (next === parent) throw new Error('Import parent is unavailable.'); parent = next;
    }
    const stat = statSync(parent), target = realpathSync(parent), identity = `${stat.dev}:${stat.ino}`;
    assertParentsCurrent(parents);
    return { stamp: `absent:${target}:${identity}`, raw: null, parents, absentParent: Object.freeze({ path: parent, target, identity }) };
  }
}
function assertParentsCurrent(parents: ImportFileObservation['parents']): void {
  for (const parent of parents) {
    const link = lstatSync(parent.path, { bigint: true }), target = statSync(parent.path, { bigint: true });
    if (realpathSync(parent.path) !== parent.target || [target.dev, target.ino, link.dev, link.ino,
      ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':') !== parent.identity) throw new Error('Import parent changed.');
  }
}

/** Own directory creation may advance the nearest parent, never replace its captured anchor. */
export function assertImportFileCurrent(path: string, observation: ImportFileObservation): void {
  assertParentsCurrent(observation.parents);
  if (!observation.absentParent) {
    if (observeImportFile(path).stamp !== observation.stamp) throw new Error('Import file changed.');
    return;
  }
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('Import file changed.');
  const anchor = observation.absentParent, stat = statSync(anchor.path);
  if (`${stat.dev}:${stat.ino}` !== anchor.identity || realpathSync(anchor.path) !== anchor.target) throw new Error('Import parent changed.');
  let parent = dirname(path);
  while (parent !== anchor.path) {
    const entry = lstatSync(parent, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Import parent changed.');
    const next = dirname(parent); if (next === parent) throw new Error('Import parent changed.'); parent = next;
  }
}

export interface PreparedImportTransitionFacts {
  readonly beforeGeneration: number;
  readonly afterGeneration: number;
  readonly phase: 'pending' | 'committed';
}
