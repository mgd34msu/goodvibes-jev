import { appendFileSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { snapshotJudgmentEvidence } from '../../gate/judgment-input.js';
import type { VerificationSource } from './types.js';
import { verificationHash } from './source.js';
import type { VerificationArchive } from './archive.js';
import { VerificationHeldError } from './types.js';

/** One private append-only journal per session, with deduplicated source chunks
 * and proposal records. Disk records never carry reusable approval authority. */
export class VerificationStore {
  readonly sources = new Map<string, VerificationSource>();
  readonly proposals = new Map<string, string>();
  private readonly written = new Set<string>();
  private readonly histories = new Map<string, VerificationArchive['histories'][number]>();
  private readonly path: string | undefined;
  private readonly root: string | undefined;
  archive: VerificationArchive | undefined;
  readonly archives = new Map<string, VerificationArchive>();
  constructor(root?: string, sessionId?: string) {
    if (!root || !sessionId) return;
    if (!isAbsolute(root) || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid verification journal location');
    this.path = join(resolve(root), '.goodvibes', 'verification', `${sessionId}.jsonl`);
    this.root = resolve(root);
    try {
      this.assertDirectories();
      if (lstatSync(this.path).isSymbolicLink()) throw new Error('Verification journal is a symbolic link');
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line) continue;
        let record: unknown; try { record = JSON.parse(line); } catch { continue; }
        // Admissible bytes and matching local identities are still untrusted
        // proposals: every restored record needs a current Jev qualification.
        try { snapshotJudgmentEvidence(record); } catch { continue; }
        const value = record as { kind?: unknown; key?: unknown; value?: unknown };
        if (typeof value.key !== 'string') continue;
        if (value.kind === 'proposal' && typeof value.value === 'string') this.proposals.set(value.key, value.value);
        if (value.kind === 'source' && value.value && typeof value.value === 'object') {
          const source = value.value as VerificationSource;
          if (typeof source.id === 'string' && typeof source.reference === 'string' && typeof source.text === 'string'
            && ['instruction', 'observation', 'answer'].includes(source.kind)) this.sources.set(source.id, source);
        }
        if (value.kind === 'history' && value.value && typeof value.value === 'object') {
          const history = value.value as VerificationArchive['histories'][number];
          if (Array.isArray(history.messages)) this.histories.set(value.key, history);
        }
        if (value.kind === 'archive' && value.value && typeof value.value === 'object') {
          const entry = value.value as VerificationArchive;
          if (Array.isArray(entry.derived) && entry.derived.every(pair => Array.isArray(pair) && Number.isSafeInteger(pair[0]) && typeof pair[1] === 'string')) {
            if (Array.isArray(entry.histories)) for (const history of entry.histories) if (history && Array.isArray(history.messages)) this.histories.set(verificationHash(history), history);
            const metadata = value.value as { historyKeys?: string[]; branch?: string };
            if (Array.isArray(metadata.historyKeys) && metadata.historyKeys.some(key => typeof key !== 'string' || !this.histories.has(key))) throw new VerificationHeldError('missing archived original source');
            this.archive = { branch: typeof metadata.branch === 'string' ? metadata.branch : 'main',
              histories: Array.isArray(metadata.historyKeys) ? metadata.historyKeys.flatMap(key => this.histories.get(key) ?? []) : [...this.histories.values()], derived: entry.derived };
            this.archives.set(this.archive.branch!, this.archive);
          }
        }
        this.written.add(verificationHash(record));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private assertDirectories(): void {
    if (!this.root) return;
    for (const path of [join(this.root, '.goodvibes'), join(this.root, '.goodvibes', 'verification')]) {
      try { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Verification directory must be an ordinary directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private append(kind: 'source' | 'proposal' | 'archive' | 'history', key: string, value: unknown): void {
    const record = { kind, key, value };
    try { snapshotJudgmentEvidence(record); }
    catch (error) { throw new VerificationHeldError('generated verification record admission', { cause: error }); }
    const hash = verificationHash(record);
    if (kind !== 'archive' && this.written.has(hash)) return;
    if (this.path) {
      try {
      const directory = dirname(this.path);
      this.assertDirectories();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Verification journal directory is a symbolic link');
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      // A leading delimiter isolates a torn last record after abrupt exit.
      try {
        appendFileSync(fd, '\n' + JSON.stringify(record) + '\n');
        if (kind === 'archive') fsyncSync(fd);
      } finally { closeSync(fd); }
      } catch (error) { throw new VerificationHeldError('verification journal storage', { cause: error }); }
    }
    this.written.add(hash);
  }
  rememberSource(source: VerificationSource): void {
    this.append('source', source.id, source); this.sources.set(source.id, source);
  }
  rememberProposal(key: string, proposal: string): void {
    this.append('proposal', key, proposal); this.proposals.set(key, proposal);
  }
  rememberArchive(value: VerificationArchive): void {
    for (const history of value.histories) {
      const key = verificationHash(history);
      if (!this.histories.has(key)) { this.append('history', key, history); this.histories.set(key, history); }
    }
    const branch = value.branch ?? 'main', previous = this.archives.get(branch);
    const position = { branch, historyKeys: value.histories.map(history => verificationHash(history)), derived: value.derived };
    if (!previous || JSON.stringify(previous.derived) !== JSON.stringify(value.derived) || JSON.stringify(previous.histories.map(history => verificationHash(history))) !== JSON.stringify(position.historyKeys))
      this.append('archive', verificationHash(position), position);
    this.archive = value; this.archives.set(branch, value);
  }
}
