import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { hashState } from '@goodvibes-jev/judgment';
import type { Contract } from './types.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import { assertContractInputAdmission, authorizeContractInputPath, createContractInputAuthority, revokeContractInputAuthority } from './input-authority.js';
import { assertContractInputOwner, captureContractInput, type ContractInputSnapshot } from './input-snapshot.js';
import { currentFileObservations } from './current-file-observations.js';
import { goalObligationSource } from './goal-obligation-proof.js';
import { renderContractAnswer } from './answer.js';

export interface PublicationInputAdmission { readonly kind: 'publication-input-admission' }
interface Admission {
  readonly contract: Contract;
  readonly original: ContractInputSnapshot;
  readonly owner: ContractInputSnapshot;
  readonly serializedOwner: string;
  readonly resultHead: string;
  readonly originalScope: string;
  readonly assertCurrent: () => void;
  used: boolean;
}
const admissions = new WeakMap<PublicationInputAdmission, Admission>();

function gitBytes(root: string, args: readonly string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['--literal-pathspecs', '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('publication input Git metadata could not be established');
  return result.stdout;
}
const git = (root: string, args: readonly string[]) => gitBytes(root, args).toString('utf8');

/** Read the immutable bytes actually selected by the publication delta, after
 * original-owner and result-path permissions have both been checked. */
function resultFile(root: string, head: string, path: string): JsonValue[] {
  const entry = git(root, ['ls-tree', '-z', head, '--', path]);
  if (!entry) return [{ operation: 'read-publication-result', source: 'native-git-object', success: true, path, missing: true, resultHead: head }];
  const separator = entry.indexOf('\t');
  const [mode, kind, oid] = entry.slice(0, separator).split(' ');
  if (separator < 0 || entry.slice(separator + 1) !== `${path}\0` || kind !== 'blob' || !['100644', '100755'].includes(mode!))
    throw new Error('publication result has an unsupported file kind or ambiguous path');
  const bytes = gitBytes(root, ['cat-file', 'blob', oid!]), text = bytes.toString('utf8');
  return [{ operation: 'read-publication-result', source: 'native-git-object', success: true, path, resultHead: head,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes) ? { binary: true } : { binary: false, text }) }];
}

/** Current owner facts are a separate publication premise. The original task,
 * captured source, accepted units and result branch are never recaptured. */
export async function admitPublicationInput(contract: Contract, filter: ReadAccessFilter | undefined, signal: AbortSignal,
  judge: (evidence: JsonValue & object) => Promise<(() => void) | null>): Promise<PublicationInputAdmission | null> {
  assertContractInputAdmission(contract);
  const scope = goalObligationSource(contract), originalScope = hashState(scope);
  const assertScope = () => {
    if (hashState(goalObligationSource(contract)) !== originalScope) throw new Error('original publication scope changed during assessment');
  };
  const original = contract.inputSnapshot, view = contract.worktreePath, branch = contract.branch;
  if (!original || !view || !branch || !filter) throw new Error('publication recovery requires its captured result and original-owner authority');
  const owner = await captureContractInput(original.sourceRoot, { signal });
  assertScope();
  if (owner.sourceIdentity !== original.sourceIdentity || owner.gitIdentity !== original.gitIdentity
    || owner.ownerRef !== original.ownerRef) throw new Error('publication recovery cannot replace the original owner repository or selected branch');
  const resultHead = git(view, ['rev-parse', 'HEAD']).trim();
  const before = new Map(original.files.map(file => [file.path, file]));
  const after = new Map(owner.files.map(file => [file.path, file]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const old = before.get(path), current = after.get(path);
    return old?.kind !== current?.kind || old?.mode !== current?.mode || old?.digest !== current?.digest;
  });
  const targets = git(original.sourceRoot, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z',
    original.inputCommit, resultHead, '--']).split('\0').filter(Boolean);
  const authority = await createContractInputAuthority(contract, view, { signal, mutable: true, branch });
  let assertCurrent: () => void = () => signal.throwIfAborted();
  try {
    const observations: JsonValue[] = [];
    for (const path of [...new Set([...changed, ...targets])]) {
      await authorizeContractInputPath(authority, path, filter, signal);
      const currentOwner = currentFileObservations(original.sourceRoot, [path], { includeText: true });
      const expected = after.get(path);
      if (expected?.kind === 'file') {
        const observation = currentOwner[0] as { success?: unknown; sha256?: unknown } | undefined;
        if (observation?.success !== true || observation.sha256 !== expected.digest)
          throw new Error('current owner file observation does not match its captured publication input');
      }
      observations.push({ path, ownerChanged: changed.includes(path), resultChanged: targets.includes(path),
        original: before.get(path) ? { kind: before.get(path)!.kind, mode: before.get(path)!.mode, digest: before.get(path)!.digest ?? null } : null,
        currentOwner,
        acceptedResult: resultFile(original.sourceRoot, resultHead, path) });
    }
    await assertContractInputOwner(owner, signal);
    if (git(view, ['rev-parse', 'HEAD']).trim() !== resultHead) throw new Error('accepted result changed during publication recovery');
    // Index-only changes and byte-identical inode replacement add no semantic
    // question. Actual content drift needs a new native compatibility reading.
    if (changed.length || owner.ownerHead !== original.ownerHead) {
      assertScope();
      const qualified = await judge({ originalScope: scope,
        acceptedResult: { answer: contract.answer ?? renderContractAnswer(contract), check: contract.checks.at(-1) as unknown as JsonValue ?? null,
          resultHead, resultPaths: targets },
        ownerChange: { originalInputTree: original.inputTree, currentOwnerTree: owner.inputTree, paths: changed,
          observations, ownerHeadAdvanced: owner.ownerHead !== original.ownerHead },
        meaning: 'Actual current-owner and accepted-result observations. Publication must preserve the current owner files, index and history. The result delta is still relative to the ORIGINAL captured input and will be applied only after Git verifies it fits the current owner. Original source, scope and accepted units are unchanged. This check judges whether the observed owner changes leave the requested result valid or require a focused integration repair; it does not execute publication or assume missing evidence.' });
      if (!qualified) return null;
      assertCurrent = qualified;
    }
    assertCurrent();
    assertScope();
    await assertContractInputOwner(owner, signal);
    assertContractInputAdmission(contract);
    if (git(view, ['rev-parse', 'HEAD']).trim() !== resultHead) throw new Error('accepted result changed after publication assessment');
    const token = Object.freeze({ kind: 'publication-input-admission' as const });
    admissions.set(token, { contract, original, owner, serializedOwner: JSON.stringify(owner), resultHead,
      originalScope, assertCurrent, used: false });
    return token;
  } finally { revokeContractInputAuthority(authority); }
}

export function publicationInputOwner(token: PublicationInputAdmission, contract: Contract): ContractInputSnapshot {
  const admission = admissions.get(token);
  if (!admission || admission.used || admission.contract !== contract || admission.original !== contract.inputSnapshot
    || admission.originalScope !== hashState(goalObligationSource(contract)) || JSON.stringify(admission.owner) !== admission.serializedOwner)
    throw new Error('publication input admission is stale or belongs to another result');
  assertContractInputAdmission(contract); admission.assertCurrent();
  if (!contract.worktreePath || git(contract.worktreePath, ['rev-parse', 'HEAD']).trim() !== admission.resultHead)
    throw new Error('publication result changed after its owner assessment');
  return admission.owner;
}

export function consumePublicationInput(token: PublicationInputAdmission, contract: Contract): void {
  publicationInputOwner(token, contract);
  admissions.get(token)!.used = true;
}
