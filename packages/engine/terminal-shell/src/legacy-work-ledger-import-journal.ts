import { createRequire } from 'node:module';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { array, boolean, enum as enumSchema, literal, number, strictObject, string, union } from 'zod/v4';
import { parseJevDecision, type JevDecision } from '@goodvibes-jev/judgment/decisions';
import { ledgerEventSchema, workLedgerCommandSchema, type WorkLedgerCommand, type WorkLedgerResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

export type LegacyImportCommand = Extract<WorkLedgerCommand, { type: 'import_legacy' }>;
export interface LegacyImportBinding {
  readonly endpoint: string; readonly projectId: string; readonly workspaceId: string;
  readonly principalId: string; readonly principalKind: string;
}
export interface LegacyImportEntry {
  readonly binding: LegacyImportBinding; readonly command: LegacyImportCommand;
  readonly state: 'pending' | 'unknown' | 'accepted' | 'rejected' | 'cancelled';
  readonly attempts: number; readonly receiptActorId: string | null;
  readonly result: WorkLedgerResult | null;
  /** Provenance only. A parsed receipt is not an execution grant. */
  readonly decisions: readonly JevDecision[];
}
export const legacyImportResultSchema = union([
  strictObject({ kind: literal('accepted'), replayed: boolean(), event: ledgerEventSchema }),
  strictObject({ kind: literal('rejected'), code: enumSchema(['invalid_command', 'forbidden', 'conflict', 'stale_evidence', 'stale_source', 'not_found', 'invalid_transition', 'request_conflict', 'cancelled', 'closed', 'invalid_state', 'host_error']), reason: string(), revision: number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }),
  strictObject({ kind: literal('indeterminate'), requestId: string().min(1).max(200), actorId: string().min(1).max(200), reason: string() }),
]);
type Value = string | number | null;
interface DatabasePort {
  exec(sql: string): void; close(): void;
  query<T = unknown>(sql: string): { get(...args: Value[]): T | null; run(...args: Value[]): unknown };
  transaction<T>(body: () => T): { immediate(): T };
}
type DatabaseConstructor = new (path: string, options: { strict: boolean }) => DatabasePort;
function databaseConstructor(): DatabaseConstructor {
  // Importing this public module under Node must not eagerly load Bun builtins.
  let module: unknown;
  try { module = createRequire(import.meta.url)('bun:sqlite'); } catch { throw new Error('Import journal requires Bun with native SQLite'); }
  if (!module || typeof module !== 'object' || !('Database' in module) || typeof module.Database !== 'function') throw new Error('Native SQLite unavailable');
  return module.Database as DatabaseConstructor;
}
export function bindingKey(binding: LegacyImportBinding): string {
  const values = [binding.endpoint, binding.projectId, binding.workspaceId, binding.principalKind, binding.principalId];
  if (values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Complete stable import binding required');
  const url = new URL(binding.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Import endpoint must exclude credentials, query and fragment');
  return JSON.stringify(values);
}
function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Import journal requires private owner-only regular files');
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
interface Row { binding: string; command: string; state: LegacyImportEntry['state']; attempts: number; actor: string | null; result: string | null; decisions: string }

/** Durable exact-command recovery. No method in this store evaluates or grants authority. */
export class LegacyImportJournal {
  private readonly db: DatabasePort;
  constructor(path: string, directorySync: (path: string) => void = syncDirectory) {
    const Database = databaseConstructor();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = statSync(dirname(path));
    if ((directory.mode & 0o022) !== 0 || (process.getuid && directory.uid !== process.getuid())) throw new Error('Import journal requires an owner-controlled directory');
    let ancestor = realpathSync(dirname(path));
    while (true) { directorySync(ancestor); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privateFile(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateFile(path);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
      if (this.db.query<{ synchronous: number }>('PRAGMA synchronous').get()?.synchronous !== 3 || this.db.query<{ journal_mode: string }>('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('Import journal requires EXTRA/DELETE durability');
      this.db.exec("CREATE TABLE IF NOT EXISTS legacy_import (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, result TEXT, actor TEXT, decisions TEXT NOT NULL DEFAULT '[]'); CREATE TABLE IF NOT EXISTS legacy_import_archive (request_id TEXT PRIMARY KEY, entry TEXT NOT NULL)");
      this.db.transaction(() => {
        if (!this.db.query("SELECT name FROM pragma_table_info('legacy_import') WHERE name='decisions'").get()) this.db.exec("ALTER TABLE legacy_import ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]'");
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  read(binding: LegacyImportBinding): LegacyImportEntry | null {
    const key = bindingKey(binding);
    const row = this.db.query<Row>('SELECT binding, command, state, attempts, result, actor, decisions FROM legacy_import WHERE slot=1').get();
    if (!row) return null;
    if (row.binding !== key) throw new Error('Import journal belongs to another endpoint, project, workspace or principal');
    const command = workLedgerCommandSchema.parse(JSON.parse(row.command));
    if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId) throw new Error('Invalid import journal command');
    if (!['pending', 'unknown', 'accepted', 'rejected', 'cancelled'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error('Invalid import journal state');
    const decisions = array(strictObject({}).passthrough()).parse(JSON.parse(row.decisions)).map(parseJevDecision);
    if (new Set(decisions.map(item => item.decisionId)).size !== decisions.length) throw new Error('Duplicate decision identity');
    return { binding: { endpoint: binding.endpoint, projectId: binding.projectId, workspaceId: binding.workspaceId, principalId: binding.principalId, principalKind: binding.principalKind }, command, state: row.state, attempts: row.attempts, receiptActorId: row.actor, result: row.result === null ? null : legacyImportResultSchema.parse(JSON.parse(row.result)), decisions };
  }
  reserve(binding: LegacyImportBinding, makeCommand: () => LegacyImportCommand, replaceRequestId?: string): LegacyImportEntry {
    return this.db.transaction(() => {
      const prior = this.read(binding);
      if (prior) {
        if (prior.command.requestId !== replaceRequestId) return prior;
        if (!['rejected', 'cancelled'].includes(prior.state)) throw new Error('Unresolved import cannot be replaced');
        this.db.query('INSERT INTO legacy_import_archive VALUES (?,?)').run(prior.command.requestId, JSON.stringify(prior));
        this.db.exec('DELETE FROM legacy_import WHERE slot=1');
      } else if (replaceRequestId) throw new Error('Replacement does not match the journal');
      const command = workLedgerCommandSchema.parse(makeCommand());
      if (command.type !== 'import_legacy' || command.manifest.projectId !== binding.projectId) throw new Error('Invalid import target');
      this.db.query("INSERT INTO legacy_import(slot,binding,command,state,attempts,result,actor,decisions) VALUES(1,?,?,'pending',0,NULL,NULL,'[]')").run(bindingKey(binding), JSON.stringify(command));
      return this.read(binding)!;
    }).immediate();
  }
  /** Call only inside an immediate transaction, before changing the current slot. */
  private readExpected(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry | null {
    const expected = workLedgerCommandSchema.parse(command);
    if (expected.type !== 'import_legacy' || expected.manifest.projectId !== binding.projectId) throw new Error('Invalid import target');
    const current = this.read(binding);
    if (current && JSON.stringify(current.command) !== JSON.stringify(expected)) throw new Error('Import command changed');
    return current;
  }
  cancel(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry | null {
    return this.db.transaction(() => { if (this.readExpected(binding, command)?.state === 'pending') this.db.exec("UPDATE legacy_import SET state='cancelled' WHERE slot=1"); return this.read(binding); }).immediate();
  }
  /** Only call at the authenticated host transport boundary, after real gate admission of this exact command. */
  dispatch(binding: LegacyImportBinding, command: LegacyImportCommand): LegacyImportEntry {
    return this.db.transaction(() => {
      const current = this.readExpected(binding, command);
      if (!current || !['pending', 'unknown'].includes(current.state)) throw new Error('Import cannot be dispatched');
      this.db.exec("UPDATE legacy_import SET state='unknown', attempts=attempts+1 WHERE slot=1"); return this.read(binding)!;
    }).immediate();
  }
  recordDecision(binding: LegacyImportBinding, command: LegacyImportCommand, raw: unknown): LegacyImportEntry {
    const decision = parseJevDecision(raw);
    return this.db.transaction(() => {
      const current = this.read(binding);
      if (!current || JSON.stringify(current.command) !== JSON.stringify(workLedgerCommandSchema.parse(command))) throw new Error('Decision command mismatch');
      const prior = current.decisions.find(item => item.decisionId === decision.decisionId);
      if (prior) { if (JSON.stringify(prior) !== JSON.stringify(decision)) throw new Error('Decision identity changed'); return current; }
      this.db.query('UPDATE legacy_import SET decisions=? WHERE slot=1').run(JSON.stringify([...current.decisions, decision])); return this.read(binding)!;
    }).immediate();
  }
  record(binding: LegacyImportBinding, command: LegacyImportCommand, raw: WorkLedgerResult): LegacyImportEntry {
    const result = legacyImportResultSchema.parse(raw);
    return this.db.transaction(() => {
      const current = this.readExpected(binding, command);
      if (!current || current.attempts === 0) throw new Error('No dispatched import');
      if (result.kind === 'accepted' && (result.event.type !== 'import_legacy' || result.event.requestId !== current.command.requestId || JSON.stringify(result.event.manifest) !== JSON.stringify(current.command.manifest))) throw new Error('Receipt command mismatch');
      if (result.kind === 'indeterminate' && result.requestId !== current.command.requestId) throw new Error('Receipt request mismatch');
      if (current.state === 'accepted') return current;
      const actor = result.kind === 'accepted' ? result.event.actorId : result.kind === 'indeterminate' ? result.actorId : current.receiptActorId;
      if (current.receiptActorId && actor !== current.receiptActorId) throw new Error('Receipt actor changed');
      const state = result.kind === 'accepted' ? 'accepted' : result.kind === 'rejected' && current.attempts === 1 ? 'rejected' : 'unknown';
      this.db.query('UPDATE legacy_import SET state=?, result=?, actor=? WHERE slot=1').run(state, JSON.stringify(result), actor); return this.read(binding)!;
    }).immediate();
  }
}
