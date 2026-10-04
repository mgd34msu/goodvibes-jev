/** Host-only original-source checks. A terminal runner is never its own attestation. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { hashState, readYesNo, type YesNoBand, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertDurableCheckpoint, parseDurableAdmission } from '../../contract/durable-admission.js';
import { assertNativeContractSource, nativeContractSourceForAdmission } from '../../contract/native-source.js';
import { UNIT_JUDGE_BANDS } from '../../contract/batteries/unit-judge.js';
import { UNIT_QUALITY_BAND } from '../../contract/batteries/unit-quality.js';
import { CHECK_SITES, runUnitCheck, type CheckSettings } from '../../contract/check.js';
import { judgeState, qualityState, trimEvidence, type FileChange } from '../../contract/evidence.js';
import { QUALITY_ITEMS, type ContractUnit, type ContractView } from '../../contract/types.js';
import type { ContractRunner } from '../../contract/runner.js';
import type { ReadAccessFilter } from '../../tools/shared/read-access.js';
import { emptyWorkItemUsage } from '../../orchestration/types.js';
import { parseNativeWorkExecutionRecord, type NativeWorkExecutionRecord } from './native-execution-types.js';
import type { WorkEvidenceReference } from './types.js';
import { nativeSettlementDigest, type NativeWorkAttestation } from './native-settlement-types.js';
export type { NativeWorkAttestation } from './native-settlement-types.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function contained(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Native artifact path must be relative');
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Native artifact escapes its execution tree');
  // A genuine deletion may remove its containing directory too. Check the
  // nearest surviving parent without following a dangling or linked ancestor.
  let parent = dirname(absolute);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Native artifact has a linked parent');
      const relParent = relative(root, parent);
      if (relParent === '..' || relParent.startsWith('../') || isAbsolute(relParent)) throw new Error('Native artifact parent escapes its execution tree');
      return absolute;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === root) throw error;
      parent = dirname(parent);
    }
  }
}
/** Terminal worktree completion can evict its tree only after applying the result. */
function evidenceRoot(contract: ContractView): string {
  if (contract.commit?.status === 'failed') throw new Error('Native deliverable was not applied or committed');
  if (contract.isolation === 'worktree' && contract.sessionMode !== true) {
    if (!contract.commit || !['applied', 'committed', 'skipped'].includes(contract.commit.status)) throw new Error('Native worktree application is unavailable');
    // A skipped application is safe only for output-only work. No branch-only file proves owner-tree completion.
    if (contract.commit.status === 'skipped' && contract.units.some(unit => unit.touchedPaths.length > 0)) throw new Error('Native changed artifacts were not applied');
  }
  return realpathSync(contract.projectRoot);
}
function readArtifact(root: string, path: string): { digest: string; text: string; byteLength: number } {
  const absolute = contained(root, path);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new Error('Native artifact must be a bounded regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest: digest('native-artifact:absent'), text: '(deleted file)', byteLength: 0 };
    throw error;
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); const named = lstatSync(contained(root, path));
    if (!before.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || before.size > 20 * 1024 * 1024) throw new Error('Native artifact changed before capture');
    const bytes = readFileSync(fd); const after = fstatSync(fd);
    if (bytes.length > 20 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Native artifact changed during capture');
    return { digest: nativeSettlementDigest({ kind: 'file', sha256: digest(bytes) }), byteLength: bytes.length, text: bytes.includes(0) ? `(binary file, ${bytes.length} bytes)` : bytes.toString('utf8') };
  } finally { closeSync(fd); }
}

export interface VerifiedNativeWorkExecution {
  readonly attestation: NativeWorkAttestation;
  readonly report: string;
  readonly contractDigest: string;
  /** Synchronous last guard for the exact frozen proof, including host-read bytes. */
  assertCurrent(): void;
}
/** Captures before joining, never resumes execution, and owns no availability retry loop. */
export async function verifyNativeWorkExecution(options: {
  readonly execution: NativeWorkExecutionRecord;
  readonly runner: Pick<ContractRunner, 'get' | 'join'>;
  readonly port: JudgmentPort;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly settings: CheckSettings;
  readonly readAccessFilter: ReadAccessFilter;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly now?: () => number;
}): Promise<VerifiedNativeWorkExecution> {
  // Parse a detached record before any borrowed hook. No original mutable requirement survives.
  const record = freeze(parseNativeWorkExecutionRecord(structuredClone(options.execution)));
  const settings = freeze(structuredClone(options.settings));
  if (!record.receipt || record.state !== 'launch-claimed') throw new Error('Native execution has no claimed durable receipt');
  const admission = parseDurableAdmission({ ...record.receipt, input: record.request.input });
  const source = record.request.input.nativeSource!;
  const current = () => { options.signal.throwIfAborted(); options.assertCurrent(); options.signal.throwIfAborted(); };
  current(); await options.runner.join(admission.contractId); current();
  const raw = options.runner.get(admission.contractId);
  if (!raw) throw new Error('Native runner checkpoint is unavailable');
  const contract = freeze(structuredClone(raw));
  assertDurableCheckpoint(contract, admission); assertNativeContractSource(contract);
  if (contract.status !== 'passed') throw new Error('Native verifier requires the bound passed contract');
  const contractDigest = nativeSettlementDigest(contract);
  const units = contract.units.flatMap(unit => unit.attemptUnits?.length ? unit.attemptUnits.filter(attempt => attempt.status === 'passed') : [unit]);
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const rawNo = (value: unknown, band: YesNoBand): number | null => {
    const answer = object(value); const probability = answer?.['noul'];
    if (answer?.['type'] !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    const reading = readYesNo({ type: 'noul', noul: probability }, band);
    return reading.verdict === 'no' && reading.outcome === 'act' ? probability : null;
  };
  function priorJudge(check: ContractView['checks'][number], criteria: ContractView['criteria'], site: string): boolean {
    const id = check.decisionIds[0]; const entry = id ? options.decisionLog.get(id) : null;
    if (!entry || entry.status !== 'answered' || entry.context.site !== site) return false;
    const answers = object(entry.answers); const questions = object(entry.questions);
    const judged = criteria.filter(criterion => criterion.disposition === 'judged');
    // Prior acceptance may have used a stricter band. At minimum its raw answer
    // must truly pass the shared high-stakes band and match the stored reading.
    const goal = answers ? rawNo(answers['goal'], UNIT_JUDGE_BANDS.high) : null;
    if (!answers || !questions || Object.keys(answers).length !== judged.length + 1
      || goal === null || goal !== check.goal.probabilityUnmet) return false;
    return judged.every((criterion, index) => {
      const raw = rawNo(answers[`criterion_${index}`], UNIT_JUDGE_BANDS.high);
      const reading = criterion.readings.find(value => value.checkId === check.id && value.decisionId === id);
      const question = object(questions[`criterion_${index}`]); const instructions = object(question?.['instructions']);
      return raw !== null && reading?.probabilityUnmet === raw && reading.verdict === 'met' && reading.outcome === 'act'
        && instructions?.['criterion'] === criterion.text;
    });
  }
  function genuine(unit: ContractView['units'][number]): boolean {
    const check = unit.checks.at(-1);
    if (!check || check.result !== 'pass' || check.goal.verdict !== 'met' || check.goal.outcome !== 'act' || check.decisionIds.length !== 2
      || !priorJudge(check, unit.criteria, CHECK_SITES.judge)) return false;
    const quality = options.decisionLog.get(check.decisionIds[1]!);
    if (!quality || quality.status !== 'answered' || quality.context.site !== CHECK_SITES.quality) return false;
    const answers = object(quality.answers);
    return !!answers && Object.keys(answers).length === QUALITY_ITEMS.length && QUALITY_ITEMS.every(item => rawNo(answers[item], UNIT_QUALITY_BAND) !== null
      && check.quality[item]?.verdict === 'no' && check.quality[item]?.outcome === 'act');
  }
  if (units.length === 0 || units.some(unit => unit.status !== 'passed' || !genuine(unit))) throw new Error('Native execution lacks genuine unit and quality checks');
  const deliverable = contract.checks.at(-1);
  if (!deliverable || deliverable.result !== 'pass' || deliverable.goal.verdict !== 'met' || deliverable.goal.outcome !== 'act'
    || deliverable.decisionIds.length !== 1 || !priorJudge(deliverable, contract.criteria, 'contract.check.deliverable-judge')) throw new Error('Native execution lacks a genuine deliverable check');
  const root = evidenceRoot(contract);
  const paths = [...new Set(contract.units.flatMap(unit => unit.touchedPaths))];
  if (paths.length > 94) throw new Error('Native evidence exceeds ledger reference capacity');
  const captured: { path: string; digest: string; text: string }[] = [];
  let bytes = 0;
  for (const path of paths) {
    current(); const absolute = contained(root, path);
    if (!await options.readAccessFilter(absolute)) throw new Error('Native artifact read is access-restricted');
    current(); const content = readArtifact(root, path); bytes += content.byteLength;
    if (bytes > 20 * 1024 * 1024) throw new Error('Native artifact capture exceeds total budget');
    captured.push({ path, ...content });
  }
  const assertCurrent = () => {
    current(); const latest = options.runner.get(admission.contractId);
    if (!latest || nativeSettlementDigest(latest) !== contractDigest || evidenceRoot(latest) !== root) throw new Error('Native contract changed during verification');
    for (const artifact of captured) if (readArtifact(root, artifact.path).digest !== artifact.digest) throw new Error('Native artifact changed during verification');
    current();
  };
  assertCurrent();
  const unit: ContractUnit = { id: 'native', groupId: 'native', title: 'Frozen native acceptance', goal: source.goal, brief: source.goal,
    role: 'research', dependsOn: [], files: [], attempts: 1,
    criteria: source.criteria.map((text, index) => ({ id: `native.c${index}`, text, quote: text, origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] })),
    status: 'checking', agentIds: [], checks: [], nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage: emptyWorkItemUsage() };
  // Only authorized, contained, host-read artifacts enter the prompt. No broad git diff can disclose unrelated files.
  const changes: FileChange[] = captured.map(item => ({ path: item.path, diff: `${item.path}\n${item.text}` }));
  const evidence = freeze(trimEvidence({ output: contract.answer ?? '', changes, gates: deliverable!.gates, commands: [] }, unit));
  const originalSource = nativeContractSourceForAdmission(contract);
  const states = new Map<string, { hash: string; questions: string; answers: string; decisionId?: string }>();
  const checkAbort = new AbortController(); const checkSignal = AbortSignal.any([options.signal, checkAbort.signal]);
  const pending = new Set<Promise<unknown>>();
  const checkPort: JudgmentPort = { ...options.port, ask(request) {
    const operation = Promise.resolve().then(async () => {
      const active = () => { checkSignal.throwIfAborted(); assertCurrent(); request.signal?.throwIfAborted(); request.beforeAttempt?.(); assertCurrent(); checkSignal.throwIfAborted(); };
      const state = freeze(structuredClone({ ...(request.state as Record<string, EntryType>), originalSource })) as unknown as EntryType;
      const questions = freeze(structuredClone(request.questions));
      const site = request.context?.site;
      if (!site || (site !== CHECK_SITES.judge && site !== CHECK_SITES.quality)) throw new Error('Unexpected native settlement decision site');
      const captured = { hash: hashState(state), questions: nativeSettlementDigest(questions) };
      // Forward the registered runUnitCheck request with detached images. This
      // adapter defines no questions or decision; the generic request type stays intact.
      const forwarded: typeof request = { ...request, state, questions, signal: checkSignal, beforeAttempt: active };
      active();
      // The shared port lends an object. Snapshot before borrowed guards or a
      // later microtask can change what the battery reads after provenance capture.
      const result = freeze(structuredClone(await options.port.ask(forwarded)));
      active();
      states.set(site, { ...captured, answers: nativeSettlementDigest(result.answers), ...(result.decisionId ? { decisionId: result.decisionId } : {}) }); return result;
    });
    pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  } };
  let result: Awaited<ReturnType<typeof runUnitCheck>>;
  try {
    result = await runUnitCheck({ contract, unit, evidence, trigger: 'completion', settings, now: options.now?.() ?? Date.now(), signal: checkSignal, checkPort });
  } catch (error) {
    checkAbort.abort(); await Promise.allSettled([...pending]); throw error;
  }
  assertCurrent(); if (result.discarded) throw new Error('Native verification cancelled');
  for (const path of paths) { if (!await options.readAccessFilter(contained(root, path))) throw new Error('Native artifact read was revoked'); assertCurrent(); }
  const decisionReferences = result.check.decisionIds.map((id, index): WorkEvidenceReference => {
    const entry = options.decisionLog.get(id); const site = index === 0 ? CHECK_SITES.judge : CHECK_SITES.quality;
    const expected = hashState({ ...(index === 0 ? judgeState(unit, evidence) : qualityState(unit, evidence)), originalSource } as unknown as EntryType);
    if (!entry || entry.status !== 'answered' || entry.context.site !== site || entry.stateHash !== expected || states.get(site)?.hash !== expected || states.get(site)?.decisionId !== id || states.get(site)?.questions !== nativeSettlementDigest(entry.questions) || states.get(site)?.answers !== nativeSettlementDigest(entry.answers)) throw new Error('Native decision provenance is missing or mismatched');
    const { notes: _notes, ...immutable } = entry;
    return { kind: 'decision', ref: `decision:${id}`, digest: nativeSettlementDigest(immutable) };
  });
  if (decisionReferences.length !== 2 || new Set(result.check.decisionIds).size !== 2) throw new Error('Native settlement requires both recorded decision batteries');
  const references: WorkEvidenceReference[] = [...decisionReferences,
    { kind: 'test', ref: `check:${contract.id}:${result.check.id}`, digest: nativeSettlementDigest(result.check) },
    { kind: 'test', ref: `execution:${contract.id}`, digest: contractDigest },
    { kind: 'test', ref: `receipt:${contract.id}`, digest: nativeSettlementDigest(record.receipt) },
    ...captured.map(item => ({ kind: 'artifact' as const, ref: `artifact:${contract.id}:${item.path}`, digest: item.digest }))];
  const criteriaResults = source.criteria.map((_text, criterionIndex) => ({ criterionIndex,
    status: result.verdicts.get(`native.c${criterionIndex}`) === 'met' ? 'satisfied' as const : result.verdicts.get(`native.c${criterionIndex}`) === 'unmet' ? 'unsatisfied' as const : 'unknown' as const,
    references: references.map(item => item.ref) }));
  const passed = result.check.result === 'pass' && criteriaResults.every(item => item.status === 'satisfied');
  result.recordAction(`native settlement ${admission.contractId}: ${passed ? 'verified' : 'failed'} against ${admission.payloadRevision}`);
  assertCurrent();
  return { attestation: freeze({ outcome: passed ? 'verified' : 'failed', reason: passed ? 'Every original native criterion and quality check passed against host-collected evidence.' : 'Original native criteria or quality did not pass verification.', source: 'host_check', criteriaResults, references }),
    report: (contract.answer?.trim() || 'Native execution finished; see revision-bound verification evidence.').slice(0, 20_000), contractDigest, assertCurrent };
}
