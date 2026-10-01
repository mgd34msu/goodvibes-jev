/**
 * Account persistence for callers with asynchronous content safety readings.
 * No default reader or judgment transport is installed here. The caller owns
 * that policy; unavailable or held readings never authorize disclosure/write.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import {
  accountSafetyFields, boundAccountRecords, buildAccountRecord, formatStore,
  parseAccountFields, sweepAccountRecords, validateAccountCreateFields,
  type AccountStoreFile, type AgentAccountCreateInput, type AgentAccountRecord,
  type AgentAccountSnapshot, type AgentAccountSweepInput, type AgentAccountSweepResult,
  type ParsedStore,
} from './account-registry.js';

/** False/clear permits a field; true/secret excludes it. Other outcomes hold. */
export type SecretLikeTextReading = boolean | {
  readonly outcome: 'clear' | 'secret' | 'held' | 'unavailable';
};

/** A separate contract: synchronous email/style consumers keep their predicate. */
export type AsyncSecretLikeTextReader = (text: string, signal?: AbortSignal) => SecretLikeTextReading | Promise<SecretLikeTextReading>;

export interface AsyncAgentAccountRegistryOptions {
  readonly storePath: string;
  readonly readSecretLikeText: AsyncSecretLikeTextReader;
}

export interface AccountRegistryOperationOptions {
  readonly signal?: AbortSignal;
}

interface FileRevision {
  readonly content: Buffer;
  readonly identity: string;
}

/** Only a genuinely missing file starts empty; read and shape failures propagate. */
function readRevision(path: string): FileRevision | null {
  let fd: number;
  // Validate the opened object, not a racy pre-stat. A plain read-only open
  // waits for a FIFO writer before fstat can reject it, blocking cancellation
  // and the whole event loop. Nonblocking open reaches descriptor validation
  // immediately; it does not change ordinary regular-file reads.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The account registry could not be read');
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('The account registry is not a regular file');
    const content = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const identity = (stat: typeof before): string => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw new Error('The account registry changed while it was being read');
    return { content, identity: identity(after) };
  } finally { closeSync(fd); }
}

function assertCurrentRevision(path: string, expected: FileRevision | null): void {
  const actual = readRevision(path);
  if (actual === null && expected === null) return;
  if (actual === null || expected === null || actual.identity !== expected.identity || !actual.content.equals(expected.content)) {
    throw new Error('The account registry changed during its safety reading; retry from the current file');
  }
}

function parsedEntries(revision: FileRevision | null): readonly unknown[] {
  if (revision === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(revision.content.toString('utf8')); }
  catch { throw new Error('The account registry contains invalid JSON and was not changed'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !('version' in parsed) || parsed.version !== 1 || !('accounts' in parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error('The account registry has an unsupported store format and was not changed');
  }
  return parsed.accounts;
}

function readingIsSecret(reading: unknown): boolean {
  if (reading === true || reading === false) return reading;
  if (typeof reading === 'object' && reading !== null && !Array.isArray(reading) && 'outcome' in reading) {
    if (reading.outcome === 'clear') return false;
    if (reading.outcome === 'secret') return true;
    if (reading.outcome === 'held' || reading.outcome === 'unavailable') {
      throw new Error('The account safety reading is unresolved; no account data was disclosed or changed');
    }
  }
  throw new TypeError('The account safety reader returned an invalid result');
}

// All instances using this path share one queue. A cancelled queued caller
// never executes, and a failed caller cannot poison subsequent operations.
const pathTails = new Map<string, Promise<void>>();

export class AsyncAgentAccountRegistry {
  private readonly storePath: string;
  private readonly reader: AsyncSecretLikeTextReader;

  constructor(options: AsyncAgentAccountRegistryOptions) {
    this.storePath = resolve(options.storePath);
    this.reader = options.readSecretLikeText;
    if (typeof this.reader !== 'function') throw new TypeError('An account safety reader is required');
  }

  async snapshot(options: AccountRegistryOperationOptions = {}): Promise<AgentAccountSnapshot> {
    return this.withStore(options.signal, async (parsed) => ({
      value: { path: this.storePath, accounts: parsed.store.accounts, droppedOnRead: parsed.dropped },
    }));
  }

  async list(options: AccountRegistryOperationOptions = {}): Promise<readonly AgentAccountRecord[]> {
    return (await this.snapshot(options)).accounts;
  }

  async get(id: string, options: AccountRegistryOperationOptions = {}): Promise<AgentAccountRecord | null> {
    options.signal?.throwIfAborted();
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return (await this.list(options)).find((account) => account.id === lookup) ?? null;
  }

  async record(input: AgentAccountCreateInput, options: AccountRegistryOperationOptions = {}): Promise<AgentAccountRecord> {
    // Capture caller-owned input before the queued operation yields.
    const captured = { ...input, ...(input.now ? { now: new Date(input.now) } : {}) };
    return this.withStore(options.signal, async (parsed, read) => {
      const fields = validateAccountCreateFields(captured);
      if (await read(accountSafetyFields(fields))) {
        throw new Error('The account registry cannot store secret-looking values. Store the secret in the secret store and record only its key name.');
      }
      const account = buildAccountRecord(fields, captured, parsed.store.accounts);
      return { value: account, write: { ...parsed.store, accounts: [...parsed.store.accounts, account] } };
    });
  }

  async forget(id: string, options: AccountRegistryOperationOptions = {}): Promise<AgentAccountRecord> {
    const lookup = id.trim().toLowerCase();
    return this.withStore(options.signal, async (parsed) => {
      const existing = parsed.store.accounts.find((account) => account.id === lookup);
      if (!existing) throw new Error(`Unknown account record ${id}`);
      return { value: existing, write: { ...parsed.store, accounts: parsed.store.accounts.filter((account) => account.id !== existing.id) } };
    });
  }

  async sweep(input: AgentAccountSweepInput = {}, options: AccountRegistryOperationOptions = {}): Promise<AgentAccountSweepResult> {
    const captured = { ...input,
      ...(input.now ? { now: new Date(input.now) } : {}),
      ...(input.knownSecretKeys ? { knownSecretKeys: [...input.knownSecretKeys] } : {}),
    };
    return this.withStore(options.signal, async (parsed) => {
      const { kept, removed } = sweepAccountRecords(parsed.store.accounts, captured);
      return { value: { removed, remaining: kept.length }, write: { ...parsed.store, accounts: kept } };
    });
  }

  private withStore<T>(
    signal: AbortSignal | undefined,
    operation: (parsed: ParsedStore, read: (fields: readonly string[]) => Promise<boolean>) => Promise<{ value: T; write?: AccountStoreFile }>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const prior = pathTails.get(this.storePath) ?? Promise.resolve();
    const pending = prior.then(async () => {
      signal?.throwIfAborted();
      const revision = readRevision(this.storePath);
      const entries = parsedEntries(revision);
      const readings = new Map<string, boolean>();
      const read = async (fields: readonly string[]): Promise<boolean> => {
        for (const text of fields) {
          signal?.throwIfAborted();
          let secret = readings.get(text);
          if (secret === undefined) {
            const result = await executePolicyCheck(() => this.reader(text, signal), signal);
            signal?.throwIfAborted();
            secret = readingIsSecret(result);
            readings.set(text, secret);
          }
          if (secret) return true;
        }
        return false;
      };
      const accounts: AgentAccountRecord[] = [];
      for (const entry of entries) {
        const account = parseAccountFields(entry);
        if (account !== null && !await read(accountSafetyFields(account))) accounts.push(account);
      }
      const parsed = boundAccountRecords(accounts, entries.length);
      const result = await operation(parsed, read);
      signal?.throwIfAborted();
      assertCurrentRevision(this.storePath, revision);
      if (result.write) this.writeStore(result.write);
      return result.value;
    });
    const tail = pending.then(() => {}, () => {});
    pathTails.set(this.storePath, tail);
    void tail.then(() => { if (pathTails.get(this.storePath) === tail) pathTails.delete(this.storePath); });
    return executePolicyCheck(() => pending, signal);
  }

  private writeStore(store: AccountStoreFile): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, formatStore(store), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.storePath);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
