import { toJson, type EntryType } from '@goodvibes-jev/judgment';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { fanOut } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, prepareJudgmentResult, retainStrictJudgmentJson } from '../gate/index.js';
import { ArchetypeLoader, type AgentArchetype } from './archetypes.js';
import { archetypeFamilyAt, type ArchetypeFamily } from './batteries/archetype-family.js';

export type { ArchetypeFamily } from './batteries/archetype-family.js';
export class ArchetypeReadingHeldError extends Error {
  constructor() { super('Archetype listing is unavailable or no longer current.'); this.name = 'ArchetypeReadingHeldError'; }
}
const identity = (entry: BigIntStats) => [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs].map(String);
function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}
function physical(path: string) {
  try {
    const own = lstatSync(path, { bigint: true });
    const target = statSync(path, { bigint: true });
    return { kind: 'present' as const, own: identity(own), target: identity(target), resolved: realpathSync(path) };
  } catch (error) { return { kind: 'unavailable' as const, code: errorCode(error) }; }
}
function directorySource(directory: string) {
  // Ancestor incarnations also bind missing directories and symlink targets.
  const ancestors: string[] = [];
  for (let path = dirname(directory);;) {
    const stamp = physical(path);
    ancestors.push(JSON.stringify({ path, stamp: stamp.kind === 'present'
      ? { kind: stamp.kind, own: stamp.own.slice(0, 3), target: stamp.target.slice(0, 3), resolved: stamp.resolved }
      : stamp }));
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  const before = physical(directory);
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith('.md')).sort(); }
  catch (error) { return { ancestors, directory: before, unavailable: errorCode(error), files: [] }; }
  const files = names.map(name => {
    const path = join(directory, name), before = physical(path);
    let bytes: Buffer | undefined, unavailable: string | undefined;
    try { bytes = readFileSync(path); } catch (error) { unavailable = errorCode(error); }
    const after = physical(path);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new ArchetypeReadingHeldError();
    return { name, stamp: after, bytes, text: bytes?.toString('utf8'), unavailable };
  });
  if (JSON.stringify(before) !== JSON.stringify(physical(directory))) throw new ArchetypeReadingHeldError();
  return { ancestors, directory: before, unavailable: undefined, files };
}
function sameSource(left: ReturnType<typeof directorySource>, right: ReturnType<typeof directorySource>): boolean {
  if (JSON.stringify(left.ancestors) !== JSON.stringify(right.ancestors)
    || JSON.stringify(left.directory) !== JSON.stringify(right.directory) || left.unavailable !== right.unavailable
    || left.files.length !== right.files.length) return false;
  return left.files.every((file, index) => {
    const current = right.files[index];
    return current !== undefined && file.name === current.name && JSON.stringify(file.stamp) === JSON.stringify(current.stamp)
      && file.unavailable === current.unavailable && (file.bytes === undefined ? current.bytes === undefined : current.bytes !== undefined && file.bytes.equals(current.bytes));
  });
}

/** Native loader output and its original complete local sources survive the reading. */
export function captureArchetypeListing(directory: string) {
  const path = resolve(directory), source = directorySource(path);
  // Screen full file bodies and names before the native parser can log a failure.
  assertJudgmentInput({ directory: path, files: source.files.map(file => ({ name: file.name, text: file.text })) });
  const prototype = ArchetypeLoader.prototype, list = prototype.listArchetypes;
  const archetypes: AgentArchetype[] = list.call(new ArchetypeLoader(path)).map(archetype => {
    if (!archetype.isCustom) return archetype;
    const document = source.files.find(file => join(path, file.name) === archetype.sourcePath);
    if (typeof document?.text !== 'string') throw new ArchetypeReadingHeldError();
    // listArchetypes deliberately leaves Markdown bodies lazy. Retain the full
    // owned source as evidence without changing the executable system prompt or
    // resolving additional file references through an unowned loader callback.
    return { ...archetype, sourceDocument: document.text };
  });
  const original = retainStrictJudgmentJson(archetypes);
  assertJudgmentInput(original.snapshot);
  const assertCurrent = () => {
    original.assertCurrent();
    if (ArchetypeLoader.prototype !== prototype || prototype.listArchetypes !== list) throw new ArchetypeReadingHeldError();
    if (!sameSource(source, directorySource(path))) throw new ArchetypeReadingHeldError();
  };
  assertCurrent();
  return Object.freeze({ archetypes: original.snapshot, assertCurrent });
}

export type ArchetypeFamilyReading =
  | { readonly kind: 'settled'; readonly family: ArchetypeFamily }
  | { readonly kind: 'held' };

/** All native entries share one canonical request. Nothing guesses a held family. */
export async function readArchetypeFamilies(archetypes: readonly AgentArchetype[], options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {}) {
  const original = retainStrictJudgmentJson(archetypes);
  assertJudgmentInput(original.snapshot);
  const parts: Record<string, ReturnType<typeof archetypeFamilyAt>> = {};
  original.snapshot.forEach((_, index) => { parts[`archetype${index}`] = archetypeFamilyAt(index); });
  const policy = retainStrictJudgmentJson(Object.values(parts).map(part => ({ items: part.items, model: part.model })));
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const current = () => {
    signal?.throwIfAborted(); original.assertCurrent(); policy.assertCurrent();
    if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new ArchetypeReadingHeldError();
    const result = callerCurrent?.(); if (result !== undefined) throw new TypeError('Invalid archetype source guard.');
  };
  current();
  if (original.snapshot.length === 0) return Object.freeze({ readings: [], assertCurrent: current });
  const state = toJson({ archetypes: original.snapshot }) as EntryType; // Include the complete system prompt; names and tools alone cannot establish a role.
  const authority = captureJudgmentPort('agents.archetype-family', { ...(signal === undefined ? {} : { signal }), assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
  const result = await fanOut(authority.port, state, parts, {
    signal: authority.signal, beforeAttempt: authority.assertCurrent, site: 'agents.archetype-family', label: 'engine.agents.archetype-family',
  });
  authority.assertCurrent();
  const readings = original.snapshot.map((_, index): ArchetypeFamilyReading => {
    const reading = result.readings[`archetype${index}`]?.family;
    return reading?.outcome === 'act' && reading.choice !== 'unknown'
      ? Object.freeze({ kind: 'settled', family: reading.choice }) : Object.freeze({ kind: 'held' });
  });
  result.recordAction('observe archetype listing families');
  authority.assertCurrent();
  return Object.freeze({ readings: Object.freeze(readings), assertCurrent: authority.assertCurrent });
}
