/** A corrective planner reads produced contract work, frozen independently of the live owner tree. */
import { join } from 'node:path';
import { IsolatedWorktree } from '../agents/worktree.js';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { assertContractExecutionView, assertContractInputObjects, assertContractInputOwner, assertContractInputView, captureContractInput, materializeContractInput, prepareContractInputParent } from './input-snapshot.js';
import type { ContractRun } from './run-context.js';

export interface FixPlannerInput {
  readonly workingDirectory: string;
  /** Discard the plan if the source result tree or the frozen view changed while it was read. */
  assertCurrent(): Promise<void>;
}

/** Shared/session execution retains its explicit live-tree semantics. */
export async function prepareFixPlannerInput(run: ContractRun): Promise<FixPlannerInput> {
  const { contract } = run;
  const signal = run.abort.signal;
  signal.throwIfAborted();
  const source = contract.worktreePath ?? contract.projectRoot;
  if (contract.isolation !== 'worktree') return { workingDirectory: source, assertCurrent: async () => { signal.throwIfAborted(); } };
  const original = contract.inputSnapshot;
  if (original === undefined || contract.branch === undefined) throw new Error('fix planning has no recorded contract input; manual recovery is required');
  assertContractInputObjects(original, contract.projectRoot);
  assertContractExecutionView(original, source, contract.branch);
  const current = await captureContractInput(source, { signal });
  const workingDirectory = join(original.sourceRoot, '.goodvibes', '.worktrees', 'contract-planner', current.id);
  const receiptPath = join(original.sourceRoot, '.goodvibes', 'contracts', 'planner-input', `${contract.id}-${current.id}.json`);
  await prepareContractInputParent(original, workingDirectory);
  await prepareContractInputParent(original, receiptPath);
  signal.throwIfAborted();
  // Keep the original admission receipt unchanged: apply-back is always checked against that owner generation.
  writeFileAtomic(receiptPath, JSON.stringify({ version: 1, purpose: 'fix', contractId: contract.id, originalInputId: original.id, workingDirectory, snapshot: current }));
  await new IsolatedWorktree(source, workingDirectory, `contract-planner/${current.id}`, contract.branch).create(current.inputCommit, false);
  await materializeContractInput(current, workingDirectory, signal);
  run.decide('created', contract.id, `fix planner admitted result view ${current.id} at ${current.inputCommit}; original input ${original.id}`);
  const assertCurrent = async (): Promise<void> => {
    signal.throwIfAborted();
    assertContractExecutionView(original, source, contract.branch!);
    try { await assertContractInputOwner(current, signal); }
    catch (error) {
      signal.throwIfAborted();
      throw new Error(`contract result changed during fix planning: ${error instanceof Error ? error.message : String(error)}`);
    }
    await assertContractInputView(current, signal, workingDirectory);
  };
  await assertCurrent();
  return { workingDirectory, assertCurrent };
}
