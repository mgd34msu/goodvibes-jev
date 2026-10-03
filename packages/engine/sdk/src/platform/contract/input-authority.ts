/** Construction-owned provenance. A captured path never grants permission by itself. */
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Contract } from './types.js';
import {
  assertContractExecutionView,
  assertContractInputObjects,
  assertContractInputView,
  CONTRACT_INPUT_EXCLUSIONS,
  type ContractInputSnapshot,
} from './input-snapshot.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';

/** Only tokens minted in this module are accepted; serialization cannot create one. */
export interface ContractInputAuthority {
  readonly kind: 'contract-input-authority';
}
interface Admission {
  readonly receipt: ContractInputSnapshot;
  readonly serialized: string;
  readonly original: ContractInputSnapshot;
  readonly contract: Contract;
  readonly signal?: AbortSignal | undefined;
}
interface Authority {
  readonly admission: Admission;
  readonly root: string;
  readonly identity: string;
  readonly mutable: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly assertView: () => Promise<void>;
  revoked: boolean;
  readonly reads: Set<string>;
}
const admissions = new WeakMap<Contract, Admission>();
const authorities = new WeakMap<ContractInputAuthority, Authority>();
const bindings = new WeakMap<object, ContractInputAuthority>();
// Revocation never makes a previously captured root an ordinary live workspace.
const capturedRoots = new Set<string>();
const identity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;

function assertAdmission(admission: Admission): void {
  admission.signal?.throwIfAborted();
  if (
    admission.contract.inputSnapshot !== admission.original ||
    JSON.stringify(admission.contract.inputSnapshot) !== admission.serialized
  )
    throw new Error('contract input receipt changed after admission');
}

/** Pin once, immediately after capture or validated restore, before external awaits. */
export function pinContractInputAdmission(contract: Contract, signal?: AbortSignal): void {
  const previous = admissions.get(contract);
  if (previous) {
    assertAdmission(previous);
    return;
  }
  const original = contract.inputSnapshot;
  if (!original) throw new Error('contract input authority requires a recorded receipt');
  const admission: Admission = {
    original,
    receipt: structuredClone(original),
    serialized: JSON.stringify(original),
    contract,
    signal,
  };
  assertAdmission(admission);
  admissions.set(contract, admission);
}

export function assertContractInputAdmission(contract: Contract): void {
  const admission = admissions.get(contract);
  if (!admission) throw new Error('contract input has no construction-owned admission');
  assertAdmission(admission);
}

export async function createContractInputAuthority(
  contract: Contract,
  root: string,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly mutable?: boolean | undefined;
    readonly branch?: string | undefined;
    readonly snapshot?: ContractInputSnapshot | undefined;
    readonly assertView?: (() => Promise<void>) | undefined;
  } = {},
): Promise<ContractInputAuthority> {
  pinContractInputAdmission(contract, options.signal);
  const admission = admissions.get(contract)!;
  const view = resolve(root);
  const snapshot = options.snapshot === undefined ? admission.receipt : structuredClone(options.snapshot);
  const assertView =
    options.assertView ??
    (options.mutable
      ? async () => {
          if (!options.branch) throw new Error('member authority requires its recorded branch');
          assertContractExecutionView(admission.receipt, view, options.branch);
        }
      : async () => {
          await assertContractInputView(snapshot, options.signal, view);
        });
  assertAdmission(admission);
  assertContractInputObjects(admission.receipt, admission.receipt.sourceRoot);
  if ((await realpath(view)) !== view) throw new Error('captured input root is redirected');
  const stat = await lstat(view, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('captured input root is not a directory');
  await assertView();
  assertAdmission(admission);
  const token = Object.freeze({ kind: 'contract-input-authority' as const });
  authorities.set(token, {
    admission,
    root: view,
    identity: identity(stat),
    mutable: options.mutable === true,
    assertView,
    signal: options.signal,
    revoked: false,
    reads: new Set(),
  });
  capturedRoots.add(view);
  return token;
}

export function getContractInputAuthority(target: object): ContractInputAuthority | undefined {
  return bindings.get(target);
}
export function bindContractInputAuthority<T extends object>(target: T, token: ContractInputAuthority | undefined): T {
  if (token !== undefined) {
    if (!authorities.has(token)) throw new Error('unrecognized contract input authority');
    bindings.set(target, token);
  }
  return target;
}
export function revokeContractInputAuthority(token: ContractInputAuthority): void {
  const state = authorities.get(token);
  if (state) state.revoked = true;
}

export function markCapturedInputPath(path: string): void {
  capturedRoots.add(resolve(path));
}

export function isCapturedInputPath(path: string): boolean {
  let absolute = resolve(path);
  try {
    absolute = realpathSync(absolute);
  } catch {
    /* A missing reserved view still fails closed below. */
  }
  if ([...capturedRoots].some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) return true;
  // Reserved runtime views also fail closed before a restored lease is rebound.
  // This is only a denial check; prefixes never confer original-owner authority.
  return /[/\\]\.goodvibes[/\\]\.worktrees[/\\](?:contract-input|contract-planner|contract)(?:[/\\]|$)/.test(absolute);
}

function stateOf(token: ContractInputAuthority): Authority {
  const state = authorities.get(token);
  if (!state || state.revoked) throw new Error('captured input authority is missing or revoked');
  state.signal?.throwIfAborted();
  assertAdmission(state.admission);
  return state;
}
export async function assertContractInputAuthority(
  token: ContractInputAuthority,
  root?: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const state = stateOf(token);
  if (root !== undefined && resolve(root) !== state.root)
    throw new Error('captured input authority belongs to another view');
  const source = await lstat(state.admission.receipt.sourceRoot, { bigint: true });
  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    identity(source) !== state.admission.receipt.sourceIdentity ||
    (await realpath(state.admission.receipt.sourceRoot)) !== state.admission.receipt.sourceRoot
  )
    throw new Error('original input root identity changed');
  const stat = await lstat(state.root, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    identity(stat) !== state.identity ||
    (await realpath(state.root)) !== state.root
  )
    throw new Error('captured input root identity changed');
  await state.assertView();
  signal?.throwIfAborted();
  stateOf(token);
}
export function contractInputAuthorityRoot(token: ContractInputAuthority): string {
  return stateOf(token).root;
}
export function contractInputAuthorityMutable(token: ContractInputAuthority): boolean {
  return stateOf(token).mutable;
}

/** Reject aliases and excluded runtime paths before any backend opens bytes. */
async function checkedPath(root: string, relativePath: string): Promise<string> {
  const pieces = relativePath.split(sep);
  let current = root;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('captured input symlink access needs an authorized alias backend');
      if (i < pieces.length - 1 && !stat.isDirectory()) throw new Error('captured input parent is not a directory');
      if (i === pieces.length - 1 && !stat.isFile() && !stat.isDirectory())
        throw new Error('captured input special-file access is unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return join(root, relativePath);
}

export async function authorizeContractInputPath(
  token: ContractInputAuthority,
  rawPath: string,
  filter: ReadAccessFilter | undefined,
  signal?: AbortSignal,
): Promise<string> {
  await assertContractInputAuthority(token, undefined, signal);
  const state = stateOf(token);
  if (!filter) throw new Error('captured input requires original-owner read authorization');
  const path = resolve(state.root, rawPath);
  const rel = relative(state.root, path);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel
      .split(sep)
      .some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as (typeof CONTRACT_INPUT_EXCLUSIONS)[number]))
  )
    throw new Error('path is outside authorized captured input');
  const original = await checkedPath(state.admission.receipt.sourceRoot, rel);
  await checkedPath(state.root, rel);
  if (!(await filter(original)) || !(await filter(path))) throw new Error('captured input path is access-restricted');
  // Recheck both roots and paths after permission callbacks can yield/revoke.
  await assertContractInputAuthority(token, undefined, signal);
  await checkedPath(state.admission.receipt.sourceRoot, rel);
  await checkedPath(state.root, rel);
  signal?.throwIfAborted();
  stateOf(token);
  state.reads.add(path);
  return path;
}

/** Includes initial map provenance before the Agent's own tool readset exists. */
export async function assertContractInputReadAccess(
  token: ContractInputAuthority,
  filter: ReadAccessFilter | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!filter) throw new Error('captured input requires original-owner read authorization');
  for (const path of stateOf(token).reads) await authorizeContractInputPath(token, path, filter, signal);
}
