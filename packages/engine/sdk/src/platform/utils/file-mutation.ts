import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, type BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';

/** A native producer can add a publication restriction, never grant authority. */
export type MutationPublication = <T>(operation: (assertCurrent: () => void) => T | Promise<T>) => Promise<T>;

/** Require the producer to finish the exact publication before releasing it. */
export async function publishFileMutation(publication: MutationPublication | undefined,
  operation: (assertCurrent: () => void) => void | Promise<void>): Promise<void> {
  if (!publication) { await operation(() => {}); return; }
  let active = true, started = false, completed = false;
  try {
    await publication(async assertCurrent => {
      if (!active || started) throw new Error('Mutation publication is not current.');
      started = true;
      const current = () => { if (!active) throw new Error('Mutation publication retired.'); assertCurrent(); };
      current(); await operation(current); current(); completed = true;
    });
    if (!completed) throw new Error('Mutation publication did not finish.');
  } finally { active = false; }
}

/** Retain the actual prepared file, so an awaited rename cannot adopt foreign bytes. */
export function capturePreparedFilePublication(path: string): (publishedPath: string) => void {
  const snapshot = (filePath: string) => {
    const before = lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
    if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Prepared publication is unavailable.');
    const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}:${stat.size}:${stat.mtimeNs}`;
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const after = lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
    if (!after || identity(before) !== identity(after) || before.ctimeNs !== after.ctimeNs) throw new Error('Prepared publication changed.');
    return `${identity(after)}:${hash}`;
  };
  const prepared = snapshot(path);
  return publishedPath => {
    if (snapshot(publishedPath) !== prepared) throw new Error('File publication does not match its prepared source.');
  };
}

/** Compare trusted backend descriptors before reading any replacement accessor. */
export function captureMutationDescriptors(subject: object, keys: readonly string[]): () => void {
  const snapshot = () => {
    const owners: object[] = [];
    for (let owner: object | null = subject; owner; owner = Object.getPrototypeOf(owner)) {
      if (nodeTypes.isProxy(owner) || owners.length >= 64) throw new Error('Mutation owner is unavailable.');
      owners.push(owner);
    }
    return { owners, fields: keys.map(key => owners.map(owner => Object.getOwnPropertyDescriptor(owner, key))) };
  };
  const captured = snapshot();
  if (captured.fields.some(chain => chain.some(field => field && !('value' in field)))) throw new Error('Mutation owner accessor is unavailable.');
  return () => {
    const current = snapshot();
    if (current.owners.length !== captured.owners.length || current.owners.some((owner, index) => owner !== captured.owners[index])
      || captured.fields.some((chain, index) => chain.some((field, depth) => {
        const next = current.fields[index]?.[depth];
        return field?.value !== next?.value || field?.get !== next?.get || field?.set !== next?.set
          || field?.writable !== next?.writable || field?.enumerable !== next?.enumerable || field?.configurable !== next?.configurable;
      }))) throw new Error('Mutation owner changed.');
  };
}

/** Private filesystem lifetime restriction. It never authorizes an operation. */
export function captureFileMutation(path: string): { readonly assertCurrent: () => void; readonly onEffect: (published?: boolean) => void } {
  const target = resolve(path);
  const file = () => {
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('File mutation target is not a private regular file.');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(readFileSync(target)).digest('hex')}`;
  };
  const ancestry = () => {
    const parents: Array<{ readonly path: string; readonly identity: string | null; readonly revision: string | null }> = [];
    let first = true;
    for (let current = dirname(target); ; current = dirname(current)) {
      const stat = lstatSync(current, { bigint: true, throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('File mutation ancestry changed.');
      parents.push({ path: current, identity: stat ? `${stat.dev}:${stat.ino}` : null,
        revision: stat ? `${stat.dev}:${stat.ino}${first ? `:${stat.ctimeNs}` : ''}` : null });
      if (stat) first = false;
      if (current === dirname(current)) break;
    }
    return parents;
  };
  let expectedFile = file(), expectedParents = ancestry();
  return {
    assertCurrent() {
      if (file() !== expectedFile || JSON.stringify(ancestry()) !== JSON.stringify(expectedParents)) throw new Error('File mutation source changed.');
    },
    onEffect(published = false) {
      if (!published && file() !== expectedFile) throw new Error('File mutation source changed.');
      const currentParents = ancestry();
      if (currentParents.length !== expectedParents.length || expectedParents.some((parent, index) => {
        const current = currentParents[index];
        return !current || current.path !== parent.path || (parent.identity !== null && parent.identity !== current.identity);
      })) throw new Error('File mutation ancestry changed.');
      expectedFile = file(); expectedParents = currentParents;
    },
  };
}
