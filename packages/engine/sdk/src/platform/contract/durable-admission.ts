/** Durable runner admission only. The native owner still owns semantic decisions and its action ledger. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { JevDecisionBinding } from '@goodvibes-jev/judgment/decisions';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { CONTRACT_ORIGINS, isContractId, type ContractView, type StartContractInput } from './types.js';
import { captureNativeContractSource } from './native-source.js';
import { delegationForbidden } from './batteries/request-shape.js';

export interface DurableContractKey {
  readonly workId: string;
  readonly criteriaId: string;
  readonly criteriaRevision: string;
  readonly attemptId: string;
}

export interface DurableContractRequest {
  readonly key: DurableContractKey;
  readonly binding: JevDecisionBinding;
  readonly input: StartContractInput;
}

/** Stable runner-owned receipt. Never a persisted permission grant. */
export interface DurableContractAdmission extends DurableContractRequest {
  readonly schemaVersion: 1 | 2;
  /** Version-2 admissions pin resolved placement before borrowed owner/launch hooks. */
  readonly execution?: DurableContractExecution | undefined;
  readonly contractId: string;
  readonly ownerAgentId: string;
  readonly payloadRevision: string;
}

export interface DurableContractExecution {
  readonly isolation: 'worktree' | 'shared';
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly baseBranch?: string | undefined;
}

export type DurableContractReceipt = Omit<DurableContractAdmission, 'input'>;

export interface DurableStartedContract {
  readonly admission: DurableContractReceipt;
  readonly contract: ContractView;
  /** A launch claim is persisted before invocation; a crash can make whether invocation happened unknowable. */
  readonly state: 'prepared' | 'launch-claimed' | 'terminal';
}

/** Trusted composition dependency, deliberately absent from serialized/model-supplied input. */
export interface DurableContractBoundary {
  /** Acquire the native ledger lock, then call launch with a synchronous live validator while holding it. */
  withCurrent(admission: DurableContractAdmission, launch: (assertCurrent: () => void) => void): void | Promise<void>;
}

export class DurableContractAdmissionError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'missing' | 'checkpoint' | 'boundary') {
    super(`Durable contract admission: ${code}`);
    this.name = 'DurableContractAdmissionError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function references(value: unknown, keys: readonly string[]): boolean {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => typeof value[key] === 'string' && /^[\x21-\x7e][\x20-\x7e]{0,255}$/.test(value[key]));
}

/** JSON canonicalization rejects values persistence cannot preserve. Undefined optional object fields are absent. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new DurableContractAdmissionError('invalid');
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}

const KEY_FIELDS = ['workId', 'criteriaId', 'criteriaRevision', 'attemptId'];
const BINDING_FIELDS = ['sourceId', 'inputRevision', 'actionId', 'actionRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'];

/** Stable criteria-set identity for native work whose criteria are an ordered array without an ID. */
export function criteriaSetIdForWork(workId: string): string {
  if (!references({ workId }, ['workId'])) throw new DurableContractAdmissionError('invalid');
  return `criteria:${createHash('sha256').update(workId).digest('hex')}`;
}

export function durableKeyHash(key: DurableContractKey): string {
  if (!references(key, KEY_FIELDS)) throw new DurableContractAdmissionError('invalid');
  return createHash('sha256').update(canonical(key)).digest('hex');
}

export function freezeDurableRequest(value: DurableContractRequest): DurableContractRequest {
  // Clone before the first await: caller mutation cannot change the operation being admitted.
  let detached: unknown;
  try { detached = JSON.parse(canonical(value)); } catch { throw new DurableContractAdmissionError('invalid'); }
  if (!record(detached) || Object.keys(detached).length !== 3
    || !references(detached['key'], KEY_FIELDS) || !references(detached['binding'], BINDING_FIELDS)
    || !record(detached['input'])) throw new DurableContractAdmissionError('invalid');
  const input = detached['input'];
  if (typeof input['ask'] !== 'string' || input['ask'].length === 0
    || typeof input['sessionId'] !== 'string' || input['sessionId'].length === 0
    || typeof input['projectRoot'] !== 'string' || input['projectRoot'].length === 0
    || typeof input['origin'] !== 'string' || !(CONTRACT_ORIGINS as readonly string[]).includes(input['origin'])) {
    throw new DurableContractAdmissionError('invalid');
  }
  if (input['taskEvidence'] !== undefined && typeof input['taskEvidence'] !== 'string') throw new DurableContractAdmissionError('invalid');
  if (input['isolation'] !== undefined && (typeof input['isolation'] !== 'string' || !['auto', 'worktree', 'shared'].includes(input['isolation']))) throw new DurableContractAdmissionError('invalid');
  if (input['nativeSource'] !== undefined) {
    let source;
    try { source = captureNativeContractSource(input['nativeSource']); } catch { throw new DurableContractAdmissionError('invalid'); }
    const key = detached['key'] as Record<string, unknown>;
    const binding = detached['binding'] as Record<string, unknown>;
    if (source.sourceId !== binding['sourceId'] || source.inputRevision !== binding['inputRevision']
      || source.criteriaId !== key['criteriaId'] || source.criteriaRevision !== key['criteriaRevision']) throw new DurableContractAdmissionError('invalid');
    input['nativeSource'] = source;
  }
  return freeze(detached as unknown as DurableContractRequest);
}

export function durablePayloadRevision(request: DurableContractRequest): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}

export function parseDurableAdmission(value: unknown): DurableContractAdmission {
  if (!record(value) || (value['schemaVersion'] !== 1 && value['schemaVersion'] !== 2)
    || Object.keys(value).length !== (value['schemaVersion'] === 2 ? 8 : 7)
    || !isContractId(value['contractId']) || typeof value['ownerAgentId'] !== 'string' || value['ownerAgentId'].length === 0
    || typeof value['payloadRevision'] !== 'string') throw new DurableContractAdmissionError('invalid');
  const request = freezeDurableRequest({ key: value['key'], binding: value['binding'], input: value['input'] } as DurableContractRequest);
  if (durablePayloadRevision(request) !== value['payloadRevision']) throw new DurableContractAdmissionError('invalid');
  let execution: DurableContractExecution | undefined;
  if (value['schemaVersion'] === 2) {
    const item = value['execution'];
    if (!record(item) || (item['isolation'] !== 'worktree' && item['isolation'] !== 'shared')
      || Object.keys(item).length !== (item['isolation'] === 'worktree' ? 4 : 1)) throw new DurableContractAdmissionError('invalid');
    if (item['isolation'] === 'worktree' && (item['branch'] !== `contract/${value['contractId'].slice(4)}`
      || item['worktreePath'] !== join(request.input.projectRoot, '.goodvibes', '.worktrees', 'contract', value['contractId'].slice(4))
      || typeof item['baseBranch'] !== 'string' || item['baseBranch'].length === 0)) throw new DurableContractAdmissionError('invalid');
    if (request.input.isolation !== undefined && request.input.isolation !== 'auto' && item['isolation'] !== request.input.isolation)
      throw new DurableContractAdmissionError('invalid');
    execution = item as unknown as DurableContractExecution;
  }
  return freeze({ ...request, schemaVersion: value['schemaVersion'] as 1 | 2, contractId: value['contractId'], ownerAgentId: value['ownerAgentId'], payloadRevision: value['payloadRevision'],
    ...(execution === undefined ? {} : { execution }) });
}

/** Checkpoint content must still name the original operation, not just copy its receipt hash. */
export function assertDurableCheckpoint(contract: ContractView, admission: DurableContractAdmission): void {
  if (contract.durableAdmission === undefined || canonical(contract.durableAdmission) !== canonical(admission)
    || contract.id !== admission.contractId || contract.ownerAgentId !== admission.ownerAgentId) {
    throw new DurableContractAdmissionError('checkpoint');
  }
  for (const field of ['ask', 'sessionId', 'origin', 'projectRoot', 'parentAgentId', 'budget', 'proposedUnits', 'nativeSource', 'taskEvidence'] as const) {
    if (canonical({ value: contract[field] }) !== canonical({ value: admission.input[field] })) {
      throw new DurableContractAdmissionError('checkpoint');
    }
  }
  if (contract.isolation !== 'worktree' && contract.isolation !== 'shared') throw new DurableContractAdmissionError('checkpoint');
  // The existing no-delegation rule intentionally uses the session's shared tree.
  // No other transition may discard the resolved placement or its captured-input path.
  const session = contract.sessionMode === true;
  if (session && (contract.shape === undefined || !delegationForbidden(contract.shape))) throw new DurableContractAdmissionError('checkpoint');
  if (contract.shape !== undefined && contract.status !== 'shaping' && session !== delegationForbidden(contract.shape)) throw new DurableContractAdmissionError('checkpoint');
  const execution: DurableContractExecution | undefined = session ? { isolation: 'shared' } : admission.execution;
  if (execution !== undefined) {
    for (const field of ['isolation', 'branch', 'worktreePath', 'baseBranch'] as const) {
      if (contract[field] !== execution[field]) throw new DurableContractAdmissionError('checkpoint');
    }
  } else if (admission.input.isolation !== undefined && admission.input.isolation !== 'auto' && contract.isolation !== admission.input.isolation) {
    throw new DurableContractAdmissionError('checkpoint');
  }
}

/** Flush the renamed entry as well as the file; admission cannot acknowledge a merely buffered directory entry. */
export function syncContractDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Immutable key-to-runner receipts. No semantic journal, outbox, retry loop, or automatic garbage collection. */
export class DurableContractAdmissions {
  private readonly directory: string;
  constructor(projectRoot: string) {
    this.directory = join(resolve(projectRoot), '.goodvibes', 'contracts', 'admissions');
  }

  private path(key: DurableContractKey): string { return join(this.directory, `${durableKeyHash(key)}.json`); }

  lock(key: DurableContractKey): Promise<() => void> {
    return acquireCrossProcessLock(`${this.path(key)}.lock`, { strictOwnership: true });
  }

  /** Held until real executor drainage, not just status change/disposal. A dead process's lease can be reclaimed. */
  lease(key: DurableContractKey): Promise<() => void> {
    return acquireCrossProcessLock(`${this.path(key)}.execution`, { strictOwnership: true, totalTimeoutMs: 100 });
  }

  private envelope(key: DurableContractKey): { admission: DurableContractAdmission; checkpoint: string } | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (!record(value) || Object.keys(value).length !== 2 || typeof value['checkpoint'] !== 'string') throw new Error();
      const admission = parseDurableAdmission(value['admission']);
      if (durableKeyHash(admission.key) !== durableKeyHash(key)) throw new Error();
      return { admission, checkpoint: value['checkpoint'] };
    } catch { throw new DurableContractAdmissionError('invalid'); }
  }

  /** Reverse identity fence for compatibility imports/resume, even if the contract-ID copy is absent. */
  findByContractId(contractId: string): DurableContractAdmission | null {
    if (!existsSync(this.directory)) return null;
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      let admission: DurableContractAdmission;
      try {
        const value: unknown = JSON.parse(readFileSync(join(this.directory, file), 'utf-8'));
        if (!record(value)) throw new Error();
        admission = parseDurableAdmission(value['admission']);
        if (file !== `${durableKeyHash(admission.key)}.json`) throw new Error();
      } catch { throw new DurableContractAdmissionError('invalid'); }
      if (admission.contractId === contractId) return admission;
    }
    return null;
  }

  read(key: DurableContractKey): DurableContractAdmission | null { return this.envelope(key)?.admission ?? null; }

  /** The authoritative checkpoint lives in the same atomic envelope as its immutable key binding. */
  checkpoint(key: DurableContractKey): string {
    const envelope = this.envelope(key);
    if (envelope === null) throw new DurableContractAdmissionError('missing');
    return envelope.checkpoint;
  }

  private persist(admission: DurableContractAdmission, checkpoint: string): void {
    writeFileAtomic(this.path(admission.key), canonical({ admission, checkpoint }));
    syncContractDirectory(this.directory);
    syncContractDirectory(dirname(this.directory));
    syncContractDirectory(dirname(dirname(this.directory)));
  }

  /** Caller holds the key lock. Binding and initial checkpoint appear in one atomic durable write. */
  write(admission: DurableContractAdmission, checkpoint: string): void {
    if (this.read(admission.key) !== null) throw new DurableContractAdmissionError('conflict');
    this.persist(admission, checkpoint);
  }

  /** Only the execution-lease holder may update a checkpoint; the receipt itself cannot change. */
  update(admission: DurableContractAdmission, checkpoint: string): void {
    const existing = this.read(admission.key);
    if (existing === null || canonical(existing) !== canonical(admission)) throw new DurableContractAdmissionError('checkpoint');
    this.persist(admission, checkpoint);
  }
}
