import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson, hashState, type DecisionLog } from '@goodvibes-jev/judgment';
import type { ContractRunner } from '../../contract/runner.js';
import { runUnitCheck, type CheckSettings } from '../../contract/check.js';
import { collectChanges, judgeState, qualityState, trimEvidence } from '../../contract/evidence.js';
import { QUALITY_ITEMS, type ContractUnit, type ContractView } from '../../contract/types.js';
import { emptyWorkItemUsage } from '../../orchestration/types.js';
import { workExecutionSchema, type WorkExecution } from './execution-types.js';
import { executionDigest } from './execution-state.js';
import type { LedgerEvidence, WorkEvidenceReference } from './types.js';

export type NativeWorkAttestation = Pick<LedgerEvidence, 'outcome' | 'reason' | 'references' | 'source' | 'criteriaResults'>;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** No raw model claim is an artifact: the host reads and identifies each file. */
function artifacts(contract: ContractView): WorkEvidenceReference[] {
  const root = realpathSync(contract.projectRoot);
  return [...new Set(contract.units.flatMap(unit => unit.touchedPaths))].map(path => {
    if (isAbsolute(path)) throw new Error('Native verification refuses absolute artifact paths');
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Native verification refuses artifact escape');
    // Never follow a model-selected link into secrets outside the work tree.
    const stat = lstatSync(absolute);
    const resolved = realpathSync(absolute);
    const realRelative = relative(root, resolved);
    if (stat.size > 20 * 1024 * 1024) throw new Error('Native artifact exceeds bounded host capture size');
    if (!stat.isFile() || stat.isSymbolicLink() || realRelative === '..' || realRelative.startsWith('../') || isAbsolute(realRelative)) throw new Error('Native verification requires contained regular artifacts');
    return { kind: 'artifact' as const, ref: `artifact:${contract.id}:${path}`, digest: digest(readFileSync(absolute)) };
  });
}

/**
 * Reuses the real contract criterion and quality batteries against the ORIGINAL
 * frozen native criteria. Planner omissions, rewritten criteria, raw completion
 * text and imported historic claims cannot establish verified work.
 */
export async function verifyNativeWorkExecution(options: {
  readonly execution: WorkExecution;
  readonly runner: Pick<ContractRunner, 'get' | 'join'>;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly settings: CheckSettings;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<NativeWorkAttestation> {
  // Capture before any runner hook or await: callers retain their mutable object.
  // Clone before parsing because JSON-valued fields may retain their references.
  let execution: WorkExecution;
  try {
    execution = freezeSnapshot(workExecutionSchema.parse(structuredClone(options.execution)));
  } catch {
    throw new Error('Invalid native execution snapshot');
  }
  if (execution.inputDigest !== executionDigest(execution)) throw new Error('Invalid native execution input digest');
  const { runner, decisionLog, signal } = options;
  if (signal?.aborted) throw new Error('Native verification cancelled');
  if (execution.contractId === null) throw new Error('Native execution has no durable runner binding');
  await runner.join(execution.contractId);
  const contract = runner.get(execution.contractId);
  if (!contract) throw new Error('Bound native contract is unavailable');
  if (signal?.aborted) throw new Error('Native verification cancelled');
  if (contract.id !== execution.contractId || contract.projectRoot !== execution.projectRoot
    || contract.sessionId !== execution.sessionId || contract.status !== 'passed') throw new Error('Native verifier requires the bound, passed contract');
  const units = contract.units.flatMap(unit => unit.attemptUnits?.length ? unit.attemptUnits.filter(attempt => attempt.status === 'passed') : [unit]);
  if (units.length === 0 || units.some(unit => {
    const check = unit.checks.at(-1);
    return unit.status !== 'passed' || !check || check.result !== 'pass'
      || check.goal.verdict !== 'met' || check.goal.outcome !== 'act'
      || QUALITY_ITEMS.some(item => check.quality[item]?.verdict !== 'no' || check.quality[item]?.outcome !== 'act')
      || check.decisionIds.length < 2 || check.decisionIds.some(id => decisionLog.get(id)?.status !== 'answered');
  })) throw new Error('Native verifier requires genuine passing execution and quality readings');
  const deliverable = contract.checks.at(-1);
  if (!deliverable || deliverable.result !== 'pass' || deliverable.decisionIds.length === 0
    || deliverable.decisionIds.some(id => decisionLog.get(id)?.status !== 'answered')) throw new Error('Native verifier requires a genuine deliverable check');
  const before = artifacts(contract);
  const unit: ContractUnit = {
    id: 'native', groupId: 'native', title: 'Frozen native acceptance', goal: execution.goal,
    brief: execution.goal, role: 'research', dependsOn: [], files: [], attempts: 1,
    criteria: execution.criteria.map((text, index) => ({ id: `native.c${index}`, text, quote: text, origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] })),
    status: 'checking', agentIds: [], checks: [], nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0,
    touchedPaths: [], usage: emptyWorkItemUsage(),
  };
  const paths = new Set(contract.units.flatMap(item => item.touchedPaths));
  const changes = (await collectChanges({ baseline: contract.baseline }, { cwd: contract.projectRoot, turns: [] })).filter(change => paths.has(change.path));
  const evidence = trimEvidence({ output: contract.answer ?? '', changes, gates: deliverable.gates, commands: [] }, unit);
  const result = await runUnitCheck({ contract, unit, evidence, trigger: 'completion', settings: options.settings, now: options.now?.() ?? Date.now(), signal });
  if (result.discarded || signal?.aborted) throw new Error('Native verification cancelled');
  const after = artifacts(contract);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native artifacts changed while Jev checked them');
  const decisionReferences = result.check.decisionIds.map((id, index): WorkEvidenceReference => {
    const entry = decisionLog.get(id);
    const expected = index === 0 ? hashState(judgeState(unit, evidence)) : hashState(qualityState(unit, evidence));
    if (!entry || entry.status !== 'answered' || entry.stateHash !== expected) throw new Error('Native verification decision provenance is missing or mismatched');
    const { notes: _notes, ...immutable } = entry;
    return { kind: 'decision', ref: `decision:${id}`, digest: digest(canonicalJson(immutable as unknown as Parameters<typeof canonicalJson>[0])) };
  });
  if (decisionReferences.length !== 2) throw new Error('Native verification requires recorded criteria and quality decisions');
  const checkReference: WorkEvidenceReference = { kind: 'test', ref: `check:${contract.id}:${result.check.id}`, digest: digest(canonicalJson(result.check as unknown as Parameters<typeof canonicalJson>[0])) };
  const executionReference: WorkEvidenceReference = { kind: 'test', ref: `execution:${contract.id}`, digest: digest(canonicalJson(contract as unknown as Parameters<typeof canonicalJson>[0])) };
  const references = [...decisionReferences, checkReference, executionReference, ...after];
  if (references.length > 100) throw new Error('Native evidence exceeds ledger reference capacity; no partial attestation published');
  const criteriaResults = execution.criteria.map((_text, criterionIndex) => {
    const verdict = result.verdicts.get(`native.c${criterionIndex}`);
    return { criterionIndex, status: verdict === 'met' ? 'satisfied' as const : verdict === 'unmet' ? 'unsatisfied' as const : 'unknown' as const,
      references: references.map(reference => reference.ref) };
  });
  const passed = result.check.result === 'pass' && criteriaResults.every(item => item.status === 'satisfied');
  result.recordAction(`native execution ${execution.id}: ${passed ? 'verified' : 'not verified'} against ${execution.inputDigest}`);
  return { outcome: passed ? 'verified' : 'failed', reason: passed ? 'Frozen native criteria and quality passed genuine Jev checks over host-collected execution evidence.' : 'Frozen native criteria or quality did not pass Jev checks.', source: 'host_check', criteriaResults, references };
}
