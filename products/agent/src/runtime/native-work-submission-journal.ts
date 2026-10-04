import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  acquireCrossProcessLock,
  confirmFileDurable,
  writeJsonFileAtomic,
} from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  nativeWorkSubmissionRequestSchema,
  type NativeWorkSubmissionRequest,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';

export const NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS = 16;
export const NATIVE_SUBMISSION_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

/** The principal must come from this connection's live verified auth.current. */
export interface NativeSubmissionJournalBinding {
  readonly endpoint: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly principalId: string;
}

export interface NativeSubmissionJournalRecord {
  readonly binding: NativeSubmissionJournalBinding;
  readonly command: NativeWorkSubmissionRequest;
}

export interface NativeSubmissionJournalIO {
  readonly writeJsonFileAtomic: typeof writeJsonFileAtomic;
  readonly confirmFileDurable: typeof confirmFileDurable;
  readonly acquireCrossProcessLock: typeof acquireCrossProcessLock;
}

export class NativeSubmissionJournalError extends Error {
  constructor(readonly code: 'invalid_binding' | 'invalid_command' | 'invalid_journal' | 'journal_limit' | 'conflict') {
    super(`Native submission journal: ${code}`);
    this.name = 'NativeSubmissionJournalError';
  }
}

interface JournalFile { readonly version: 1; readonly records: NativeSubmissionJournalRecord[]; }
const bindingKeys = ['endpoint', 'projectId', 'workspace', 'principalId'] as const;
const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
);
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

function copyBinding(value: unknown): NativeSubmissionJournalBinding {
  if (!ownKeys(value, bindingKeys) || !bindingKeys.every(key => typeof value[key] === 'string'
    && value[key].length > 0 && value[key].length <= 4096 && /\S/u.test(value[key]))) {
    throw new NativeSubmissionJournalError('invalid_binding');
  }
  const binding = value as unknown as NativeSubmissionJournalBinding;
  // Never persist credentials, bearer-bearing queries or fragments in an endpoint.
  let endpoint: URL;
  try { endpoint = new URL(binding.endpoint); } catch { throw new NativeSubmissionJournalError('invalid_binding'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new NativeSubmissionJournalError('invalid_binding');
  }
  return { endpoint: binding.endpoint, projectId: binding.projectId, workspace: binding.workspace, principalId: binding.principalId };
}

function copyCommand(value: unknown): NativeWorkSubmissionRequest {
  const parsed = nativeWorkSubmissionRequestSchema.safeParse(value);
  if (!parsed.success) throw new NativeSubmissionJournalError('invalid_command');
  return parsed.data;
}

const sameBinding = (left: NativeSubmissionJournalBinding, right: NativeSubmissionJournalBinding): boolean => (
  bindingKeys.every(key => left[key] === right[key])
);
const sameCommand = (left: NativeWorkSubmissionRequest, right: NativeWorkSubmissionRequest): boolean => (
  left.requestId === right.requestId && left.inputId === right.inputId && left.expectedRevision === right.expectedRevision
  && left.goal === right.goal && left.criteria.length === right.criteria.length
  && left.criteria.every((criterion, index) => criterion === right.criteria[index])
);

function validateFile(value: unknown): JournalFile {
  if (!ownKeys(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new NativeSubmissionJournalError('invalid_journal');
  }
  if (value.records.length > NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS) throw new NativeSubmissionJournalError('journal_limit');
  const records: NativeSubmissionJournalRecord[] = [];
  for (const record of value.records) {
    if (!ownKeys(record, ['binding', 'command'])) throw new NativeSubmissionJournalError('invalid_journal');
    let parsed: NativeSubmissionJournalRecord;
    try { parsed = { binding: copyBinding(record.binding), command: copyCommand(record.command) }; }
    catch { throw new NativeSubmissionJournalError('invalid_journal'); }
    if (records.some(existing => sameBinding(existing.binding, parsed.binding))) throw new NativeSubmissionJournalError('invalid_journal');
    records.push(parsed);
  }
  return { version: 1, records };
}

/** Check existing ancestors as well as the final file; never adopt symlink-backed state. */
function assertDirectoryChain(path: string): void {
  for (let current = dirname(path); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeSubmissionJournalError('invalid_journal');
    } catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) break;
  }
}

function readFile(path: string): JournalFile {
  let stat: Stats;
  try { stat = lstatSync(path); }
  catch (error) { if (missing(error)) return { version: 1, records: [] }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeSubmissionJournalError('invalid_journal');
  if (stat.size > NATIVE_SUBMISSION_JOURNAL_MAX_BYTES) throw new NativeSubmissionJournalError('journal_limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new NativeSubmissionJournalError('invalid_journal');
    if (opened.size > NATIVE_SUBMISSION_JOURNAL_MAX_BYTES) throw new NativeSubmissionJournalError('journal_limit');
    const bytes = new Uint8Array(NATIVE_SUBMISSION_JOURNAL_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > NATIVE_SUBMISSION_JOURNAL_MAX_BYTES) throw new NativeSubmissionJournalError('journal_limit');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new NativeSubmissionJournalError('invalid_journal'); }
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
export class NativeWorkSubmissionJournal {
  readonly path: string;
  private readonly io: NativeSubmissionJournalIO;

  constructor(path: string, io: Partial<NativeSubmissionJournalIO> = {}) {
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

  async read(binding: NativeSubmissionJournalBinding): Promise<NativeSubmissionJournalRecord | undefined> {
    const selected = copyBinding(binding);
    return this.locked(() => readFile(this.path).records.find(record => sameBinding(record.binding, selected)));
  }

  /** null means absent, never an unconditional overwrite. */
  async save(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest, expectedRequestId: string | null): Promise<void> {
    const record = { binding: copyBinding(binding), command: copyCommand(command) };
    if (expectedRequestId !== null && (typeof expectedRequestId !== 'string' || !expectedRequestId.length)) {
      throw new NativeSubmissionJournalError('conflict');
    }
    await this.locked(() => {
      const file = readFile(this.path);
      const index = file.records.findIndex(existing => sameBinding(existing.binding, record.binding));
      const current = file.records[index];
      if ((current?.command.requestId ?? null) !== expectedRequestId) throw new NativeSubmissionJournalError('conflict');
      if (current && current.command.requestId === record.command.requestId && !sameCommand(current.command, record.command)) {
        throw new NativeSubmissionJournalError('conflict');
      }
      if (index < 0) file.records.push(record); else file.records[index] = record;
      if (file.records.length > NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS
        || Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_SUBMISSION_JOURNAL_MAX_BYTES) {
        throw new NativeSubmissionJournalError('journal_limit');
      }
      this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    });
  }

  /** Confirm exact visible intent and durable file/ancestry before any replay POST. */
  async confirm(binding: NativeSubmissionJournalBinding, command: NativeWorkSubmissionRequest): Promise<void> {
    const selected = copyBinding(binding);
    const expected = copyCommand(command);
    await this.locked(() => {
      const current = readFile(this.path).records.find(record => sameBinding(record.binding, selected));
      if (!current || !sameCommand(current.command, expected)) throw new NativeSubmissionJournalError('conflict');
      this.io.confirmFileDurable(this.path);
    });
  }
}
