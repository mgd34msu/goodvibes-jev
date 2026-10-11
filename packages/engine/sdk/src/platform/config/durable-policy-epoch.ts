/** Actual configuration-owner epochs. File contents alone cannot preserve A -> B -> A history. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { confirmFileDurable, writeJsonFileAtomic } from '../utils/atomic-json-store.js';

interface Epoch { readonly version: 1; readonly incarnation: string; readonly fileIdentity: string; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ancestry(path: string, allowMissing = false): readonly unknown[] {
  const result: unknown[] = [];
  for (let parent = dirname(resolve(path));;) {
    try {
      const entry = lstatSync(parent, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Policy ancestor changed');
      result.push([parent, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)]);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  return result;
}
function fileIdentity(path: string): string {
  const ancestors = ancestry(path);
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Policy source aliases are unsupported');
    const before = statSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Policy source is not an ordinary file');
    const bytes = readFileSync(path);
    const after = statSync(path, { bigint: true });
    const facts = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
    if (JSON.stringify(facts(before)) !== JSON.stringify(facts(after))) throw new Error('Policy source changed while reading');
    return digest([ancestors, facts(after), createHash('sha256').update(bytes).digest('hex')]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return digest([ancestors, 'absent']);
    throw error;
  }
}
function assertUnlocked(path: string): void {
  try { lstatSync(`${path}.owner-lock`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Durable policy epoch has outstanding ownership');
}
function read(path: string): Epoch {
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n) throw new Error('Durable policy epoch is not an ordinary file');
  const before = readFileSync(path, 'utf8'); const value = JSON.parse(before) as Epoch;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || value.version !== 1
    || typeof value.incarnation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.incarnation)
    || typeof value.fileIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(value.fileIdentity)) throw new Error('Invalid durable policy epoch');
  confirmFileDurable(path);
  if (readFileSync(path, 'utf8') !== before) throw new Error('Durable policy epoch changed');
  const after = lstatSync(path, { bigint: true });
  if (!after.isFile() || after.nlink !== 1n || after.dev !== file.dev || after.ino !== file.ino || after.size !== file.size
    || after.mtimeNs !== file.mtimeNs || after.ctimeNs !== file.ctimeNs) throw new Error('Durable policy epoch identity changed');
  return value;
}
function locked<T>(path: string, operation: () => T): T {
  ancestry(path, true); // Do not create directories through an existing alias.
  mkdirSync(dirname(path), { recursive: true }); const rootIdentity = digest(ancestry(path)); const lock = `${path}.owner-lock`;
  mkdirSync(lock); const owned = lstatSync(lock);
  const assertOwned = () => {
    if (digest(ancestry(path)) !== rootIdentity) throw new Error('Durable policy epoch root changed');
    const current = lstatSync(lock);
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino || current.birthtimeMs !== owned.birthtimeMs) throw new Error('Durable policy epoch ownership changed');
  };
  try { assertOwned(); const result = operation(); assertOwned(); return result; }
  finally { assertOwned(); rmdirSync(lock); }
}

/**
 * Created only from ConfigManager's own resolved roots. Ordinary fresh config
 * does not create continuation history. Explicit new-source capture activates
 * it; subsequent owners read existing history without manufacturing or repairing
 * it. Once history is observed, mutation intent must commit before effects.
 * Existing lock ambiguity is never stolen.
 */
export class DurablePolicyEpochOwner {
  private failed = false;
  private active = false;
  private readonly roots: readonly string[];
  private readonly enabled: boolean;
  private accepted = new Map<string, Epoch>();
  private readonly ownerRoots = new Map<string, string>();
  private assertRoot(root: string): void {
    const identity = digest(ancestry(root)); const expected = this.ownerRoots.get(root);
    if (expected && expected !== identity) throw new Error('Durable policy owner root changed');
    this.ownerRoots.set(root, identity);
  }
  private historyExists(): boolean {
    return this.roots.some(root => {
      try { lstatSync(`${root}.policy-epoch.json`); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
  }
  constructor(roots: readonly string[], initialize: boolean) {
    this.roots = Object.freeze([...new Set(roots)].sort());
    this.enabled = initialize;
    if (!initialize) { this.failed = true; return; }
    // Ordinary configuration does not create durable continuation state. Once
    // any owner history exists, however, every later mutation must honor it,
    // including before this process has attempted recovery or new issuance.
    try {
      this.active = this.historyExists();
      if (!this.active) return;
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`; assertUnlocked(path); this.assertRoot(root);
        const current = read(path);
        if (current.fileIdentity !== fileIdentity(root)) throw new Error('Configuration policy image changed');
        assertUnlocked(path); this.accepted.set(root, current);
      }
    } catch { this.failed = true; }
  }

  /** Explicit fresh-source issuance establishes history; recovery never does. */
  capture(effective: unknown): string {
    if (!this.enabled) throw new Error('Durable configuration policy ownership is unavailable');
    if (this.active) return this.current(effective);
    // Another manager introduced policy history after this one hydrated. Do
    // not stamp that owner's new file state onto this owner's stale values.
    if (this.historyExists()) {
      this.active = true; this.failed = true;
      throw new Error('Configuration policy owner changed; reload before new issuance');
    }
    this.active = true;
    try {
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          let current: Epoch | undefined;
          try { current = read(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (current) throw new Error('Configuration policy owner changed during issuance');
          const identity = fileIdentity(root);
          current = { version: 1, incarnation: randomUUID(), fileIdentity: identity };
          writeJsonFileAtomic(path, current, { durable: true, mode: 0o600 });
          this.accepted.set(root, current);
        });
      }
      this.failed = false;
    } catch { this.failed = true; }
    return this.current(effective);
  }

  /** Called BEFORE every actual mutation/reload attempt, including failed/no-op changes. */
  advance(): void {
    // A read-only manager never issued durable history and keeps its ordinary
    // runtime-overlay API. A writable owner must durably revoke old history
    // before any effect, even if a preceding read or partial write faulted.
    if (!this.enabled) return;
    if (!this.active) {
      try { this.active = this.historyExists(); }
      catch {
        // This serving owner has neither issued nor observed durable history.
        // Discovery failure withholds that capability, while ordinary config
        // keeps its existing fail-restrictive/read-error handling. No durable
        // source can have been captured from this owner in this state.
        this.failed = true; return;
      }
      if (!this.active) return;
    }
    try {
      const accepted = new Map<string, Epoch>();
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          try {
            const source = lstatSync(root);
            if (!source.isFile() || source.nlink !== 1) throw new Error('Policy source is not an ordinary file');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const previous = read(path);
          // Do not read the possibly malformed/unreadable policy here. The
          // actual ConfigManager mutation owns restrictive fallback/error
          // handling. Its prior image is obsolete as soon as the nonce moves.
          const next: Epoch = { ...previous, incarnation: randomUUID() };
          writeJsonFileAtomic(path, next, { durable: true, mode: 0o600 });
          accepted.set(root, next);
        });
      }
      this.accepted = accepted;
      this.failed = false;
    } catch (error) {
      this.failed = true;
      throw new Error('Durable configuration mutation intent could not be persisted', { cause: error });
    }
  }

  /** Reads never establish missing history or refresh a stale external image. */
  current(effective: unknown): string {
    if (!this.active || this.failed) throw new Error('Durable configuration policy ownership is unavailable');
    try {
      const identities = this.roots.map(root => {
        const path = `${root}.policy-epoch.json`; assertUnlocked(path);
        const row = read(path);
        if (JSON.stringify(row) !== JSON.stringify(this.accepted.get(root))) throw new Error('Configuration policy owner changed');
        if (row.fileIdentity !== fileIdentity(root)) throw new Error('Configuration policy image changed');
        assertUnlocked(path); return [root, row.incarnation, row.fileIdentity];
      });
      return digest([identities, effective]);
    } catch (error) { this.failed = true; throw new Error('Durable configuration policy ownership is unavailable', { cause: error }); }
  }

  /** Preserve the advanced nonce while adopting this owner's completed write image. */
  reconcile(): void {
    if (!this.active || this.failed) return;
    try {
      for (const root of this.roots) {
        const path = `${root}.policy-epoch.json`;
        locked(path, () => {
          this.assertRoot(root);
          const row = read(path); const identity = fileIdentity(root);
          const expected = this.accepted.get(root);
          if (!expected || row.incarnation !== expected.incarnation) throw new Error('Configuration policy owner changed');
          const next = { ...row, fileIdentity: identity };
          if (row.fileIdentity !== identity) writeJsonFileAtomic(path, next, { durable: true, mode: 0o600 });
          this.accepted.set(root, next);
        });
      }
    } catch { this.failed = true; }
  }
}
