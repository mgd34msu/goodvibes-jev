import { nativeWorkExecutionIdentitySchema, type NativeWorkExecutionIdentity } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  acquireCrossProcessLock,
  confirmFileDurable,
  writeJsonFileAtomic,
} from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeSourceRefSchema,
  type NativeConversationIntakeSourceRef,
  type NativeConversationIntakeCaptureRequest,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';

export const NATIVE_INTAKE_JOURNAL_MAX_RECORDS = 16;
export const NATIVE_INTAKE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

/** The principal must come from this connection's live verified auth.current. */
export interface NativeIntakeJournalBinding {
  readonly endpoint: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly principalId: string;
}

export interface NativeIntakeExecutionIntent {
  readonly sourceRevision: string;
  readonly target: NativeWorkExecutionIdentity;
}

export interface NativeIntakeJournalOptions { readonly delivery?: 'hosted'; }

export interface NativeIntakeJournalRecord {
  readonly binding: NativeIntakeJournalBinding;
  readonly command: NativeConversationIntakeCaptureRequest;
  readonly delivery?: 'hosted';
  /** First authoritative source identity, never refreshed during recovery. */
  readonly hostedSource?: NativeConversationIntakeSourceRef;
  readonly dispatch?: { readonly sourceRevision: string };
  readonly execution?: NativeIntakeExecutionIntent;
}

export interface NativeIntakeJournalIO {
  readonly writeJsonFileAtomic: typeof writeJsonFileAtomic;
  readonly confirmFileDurable: typeof confirmFileDurable;
  readonly acquireCrossProcessLock: typeof acquireCrossProcessLock;
}

export class NativeIntakeJournalError extends Error {
  constructor(readonly code: 'invalid_binding' | 'invalid_command' | 'invalid_journal' | 'journal_limit' | 'conflict') {
    super(`Native intake journal: ${code}`);
    this.name = 'NativeIntakeJournalError';
  }
}

interface JournalFile { readonly version: 1; readonly records: NativeIntakeJournalRecord[]; }
const bindingKeys = ['endpoint', 'projectId', 'workspace', 'principalId'] as const;
const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
);
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

function copyBinding(value: unknown): NativeIntakeJournalBinding {
  if (!ownKeys(value, bindingKeys) || !bindingKeys.every(key => typeof value[key] === 'string'
    && value[key].length > 0 && value[key].length <= 4096 && /\S/u.test(value[key]))) {
    throw new NativeIntakeJournalError('invalid_binding');
  }
  const binding = value as unknown as NativeIntakeJournalBinding;
  // Never persist credentials, bearer-bearing queries or fragments in an endpoint.
  let endpoint: URL;
  try { endpoint = new URL(binding.endpoint); } catch { throw new NativeIntakeJournalError('invalid_binding'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new NativeIntakeJournalError('invalid_binding');
  }
  return { endpoint: binding.endpoint, projectId: binding.projectId, workspace: binding.workspace, principalId: binding.principalId };
}

function copyCommand(value: unknown): NativeConversationIntakeCaptureRequest {
  const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.continuation?.selectedDiff !== undefined) throw new NativeIntakeJournalError('invalid_command');
  return parsed.data;
}

const sameBinding = (left: NativeIntakeJournalBinding, right: NativeIntakeJournalBinding): boolean => (
  bindingKeys.every(key => left[key] === right[key])
);
const sameCommand = (left: NativeConversationIntakeCaptureRequest, right: NativeConversationIntakeCaptureRequest): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

function copyExecutionIntent(value: unknown): NativeIntakeExecutionIntent {
  if (!ownKeys(value, ['sourceRevision', 'target']) || typeof value.sourceRevision !== 'string' || !value.sourceRevision.length || value.sourceRevision.length > 200) throw new NativeIntakeJournalError('invalid_command');
  const target = nativeWorkExecutionIdentitySchema.safeParse(value.target);
  if (!target.success) throw new NativeIntakeJournalError('invalid_command');
  return { sourceRevision: value.sourceRevision, target: target.data };
}

function validateFile(value: unknown): JournalFile {
  if (!ownKeys(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new NativeIntakeJournalError('invalid_journal');
  }
  if (value.records.length > NATIVE_INTAKE_JOURNAL_MAX_RECORDS) throw new NativeIntakeJournalError('journal_limit');
  const records: NativeIntakeJournalRecord[] = [];
  for (const record of value.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Object.hasOwn(record, 'binding') || !Object.hasOwn(record, 'command')
      || Object.keys(record).some(key => !['binding', 'command', 'delivery', 'hostedSource', 'dispatch', 'execution'].includes(key))) throw new NativeIntakeJournalError('invalid_journal');
    const value = record as Record<string, unknown>;
    if (Object.hasOwn(value, 'delivery') && value.delivery !== 'hosted') throw new NativeIntakeJournalError('invalid_journal');
    let parsed: NativeIntakeJournalRecord;
    try { parsed = { binding: copyBinding(value.binding), command: copyCommand(value.command), ...(value.delivery === 'hosted' ? { delivery: 'hosted' as const } : {}) }; }
    catch { throw new NativeIntakeJournalError('invalid_journal'); }
    if ('hostedSource' in record) {
      const source = nativeConversationIntakeSourceRefSchema.safeParse(record.hostedSource);
      if (parsed.delivery !== 'hosted' || !source.success || source.data.continuation?.selectedDiff !== undefined || source.data.inputId !== parsed.command.inputId
        || source.data.continuation?.sessionId !== parsed.command.continuation?.sessionId) throw new NativeIntakeJournalError('invalid_journal');
      parsed = { ...parsed, hostedSource: source.data };
    }
    if ('dispatch' in record) {
      if (!ownKeys(record.dispatch, ['sourceRevision']) || typeof record.dispatch.sourceRevision !== 'string' || !record.dispatch.sourceRevision.length || record.dispatch.sourceRevision.length > 200) throw new NativeIntakeJournalError('invalid_journal');
      parsed = { ...parsed, dispatch: { sourceRevision: record.dispatch.sourceRevision } };
    }
    if ('execution' in record) {
      try { parsed = { ...parsed, execution: copyExecutionIntent(record.execution) }; }
      catch { throw new NativeIntakeJournalError('invalid_journal'); }
    }
    if ((parsed.dispatch && (parsed.execution || parsed.delivery === 'hosted')) || (parsed.command.continuation && parsed.delivery !== 'hosted')) throw new NativeIntakeJournalError('invalid_journal');
    if (records.some(existing => sameBinding(existing.binding, parsed.binding))) throw new NativeIntakeJournalError('invalid_journal');
    records.push(parsed);
  }
  return { version: 1, records };
}

/** Check existing ancestors as well as the final file; never adopt symlink-backed state. */
function assertDirectoryChain(path: string): void {
  for (let current = dirname(path); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeIntakeJournalError('invalid_journal');
    } catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) break;
  }
}

function readFile(path: string): JournalFile {
  let stat: Stats;
  try { stat = lstatSync(path); }
  catch (error) { if (missing(error)) return { version: 1, records: [] }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeIntakeJournalError('invalid_journal');
  if (stat.size > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new NativeIntakeJournalError('invalid_journal');
    if (opened.size > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
    const bytes = new Uint8Array(NATIVE_INTAKE_JOURNAL_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new NativeIntakeJournalError('invalid_journal'); }
    return validateFile(value);
  } finally { closeSync(fd); }
}

/**
 * Product-owned, bounded restart journal. Every mutation requires a strict lock
 * and durable publication. An AtomicWriteDurabilityError is deliberately allowed
 * to escape unchanged: published-indeterminate bytes must never be rolled back,
 * deleted, treated as absent or used for a POST without explicit confirmation.
 * There is no expiry or eviction of unresolved identities.
 */
export class NativeConversationIntakeJournal {
  readonly path: string;
  private readonly io: NativeIntakeJournalIO;

  constructor(path: string, io: Partial<NativeIntakeJournalIO> = {}) {
    this.path = resolve(path);
    this.io = { writeJsonFileAtomic, confirmFileDurable, acquireCrossProcessLock, ...io };
  }

  private async locked<T>(operation: () => T): Promise<T> {
    assertDirectoryChain(this.path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.io.acquireCrossProcessLock(`${this.path}.lock`, { strictOwnership: true });
    try {
      assertDirectoryChain(this.path);
      return operation();
    } finally { release(); }
  }

  async read(binding: NativeIntakeJournalBinding): Promise<NativeIntakeJournalRecord | undefined> {
    const selected = copyBinding(binding);
    return this.locked(() => readFile(this.path).records.find(record => sameBinding(record.binding, selected)));
  }

  /** null means absent, never an unconditional overwrite. */
  async save(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, expectedRequestId: string | null, options: NativeIntakeJournalOptions = {}): Promise<void> {
    if (Object.keys(options).some(key => key !== 'delivery') || (options.delivery !== undefined && options.delivery !== 'hosted')) throw new NativeIntakeJournalError('invalid_command');
    const record: NativeIntakeJournalRecord = { binding: copyBinding(binding), command: copyCommand(command), ...(options.delivery ? { delivery: options.delivery } : {}) };
    if (record.command.continuation && record.delivery !== 'hosted') throw new NativeIntakeJournalError('invalid_command');
    if (expectedRequestId !== null && (typeof expectedRequestId !== 'string' || !expectedRequestId.length)) {
      throw new NativeIntakeJournalError('conflict');
    }
    await this.locked(() => {
      const file = readFile(this.path);
      const index = file.records.findIndex(existing => sameBinding(existing.binding, record.binding));
      const current = file.records[index];
      if ((current?.command.requestId ?? null) !== expectedRequestId) throw new NativeIntakeJournalError('conflict');
      if (current && current.command.requestId === record.command.requestId && (!sameCommand(current.command, record.command) || current.delivery !== record.delivery)) {
        throw new NativeIntakeJournalError('conflict');
      }
      if (index < 0) file.records.push(record); else file.records[index] = current?.command.requestId === record.command.requestId
        ? { ...record, ...(current.hostedSource ? { hostedSource: current.hostedSource } : {}), ...(current.dispatch ? { dispatch: current.dispatch } : {}), ...(current.execution ? { execution: current.execution } : {}) } : record;
      if (file.records.length > NATIVE_INTAKE_JOURNAL_MAX_RECORDS
        || Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES) {
        throw new NativeIntakeJournalError('journal_limit');
      }
      this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    });
  }

  /** Record the first authenticated source identity before hosted mutations. */
  async saveHostedSource(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, source: NativeConversationIntakeSourceRef): Promise<void> {
    const selected = copyBinding(binding); const expected = copyCommand(command);
    const parsed = nativeConversationIntakeSourceRefSchema.safeParse(source);
    if (!parsed.success || parsed.data.continuation?.selectedDiff !== undefined || parsed.data.inputId !== expected.inputId || parsed.data.continuation?.sessionId !== expected.continuation?.sessionId) throw new NativeIntakeJournalError('conflict');
    await this.locked(() => {
      const file = readFile(this.path);
      const index = file.records.findIndex(record => sameBinding(record.binding, selected));
      const current = file.records[index];
      if (!current || !sameCommand(current.command, expected) || current.delivery !== 'hosted' || current.dispatch) throw new NativeIntakeJournalError('conflict');
      if (current.hostedSource) {
        if (JSON.stringify(current.hostedSource) !== JSON.stringify(parsed.data)) throw new NativeIntakeJournalError('conflict');
        this.io.confirmFileDurable(this.path); return;
      }
      file.records[index] = { ...current, hostedSource: parsed.data };
      if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
      this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    });
  }

  /** An ambiguous published claim is never cleared or replayed after restart. */
  async claimTurn(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string): Promise<boolean> {
    const selected = copyBinding(binding); const expected = copyCommand(command);
    if (!sourceRevision || sourceRevision.length > 200) throw new NativeIntakeJournalError('conflict');
    return this.locked(() => {
      const file = readFile(this.path);
      const index = file.records.findIndex(record => sameBinding(record.binding, selected));
      const current = file.records[index];
      if (!current || !sameCommand(current.command, expected)) throw new NativeIntakeJournalError('conflict');
      if (current.execution || current.delivery === 'hosted') throw new NativeIntakeJournalError('conflict');
      if (current.dispatch) {
        if (current.dispatch.sourceRevision !== sourceRevision) throw new NativeIntakeJournalError('conflict');
        return false;
      }
      file.records[index] = { ...current, dispatch: { sourceRevision } };
      if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
      this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
      return true;
    });
  }

  /** Immutable target from the authenticated work receipt; never select a newer attempt. */
  async saveExecutionIntent(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, intent: NativeIntakeExecutionIntent): Promise<void> {
    const selected = copyBinding(binding); const expected = copyCommand(command); const captured = copyExecutionIntent(intent);
    await this.locked(() => {
      const file = readFile(this.path);
      const index = file.records.findIndex(record => sameBinding(record.binding, selected));
      const current = file.records[index];
      if (!current || !sameCommand(current.command, expected) || current.dispatch) throw new NativeIntakeJournalError('conflict');
      if (current.execution) {
        if (JSON.stringify(current.execution) !== JSON.stringify(captured)) throw new NativeIntakeJournalError('conflict');
        this.io.confirmFileDurable(this.path); return;
      }
      file.records[index] = { ...current, execution: captured };
      if (Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_INTAKE_JOURNAL_MAX_BYTES) throw new NativeIntakeJournalError('journal_limit');
      this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    });
  }

  /** Confirm exact visible intent and durable file/ancestry before any replay POST. */
  async confirm(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest): Promise<void> {
    const selected = copyBinding(binding);
    const expected = copyCommand(command);
    await this.locked(() => {
      const current = readFile(this.path).records.find(record => sameBinding(record.binding, selected));
      if (!current || !sameCommand(current.command, expected)) throw new NativeIntakeJournalError('conflict');
      this.io.confirmFileDurable(this.path);
    });
  }
}
