/** Composition regressions: native semantic ownership, durable admission and captured-input provenance. */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  buildFixPlannerPrompt, contractPath, readContractSnapshot,
  type Contract, type DurableContractRequest, type NativeContractSource,
} from '../../sdk/src/platform/contract/index.js';
import { DurableContractAdmissions } from '../../sdk/src/platform/contract/durable-admission.js';
import {
  assertContractInputAuthority, authorizeContractInputPath, contractInputAuthoritySourceRoot,
  getContractInputAuthority,
} from '../../sdk/src/platform/contract/input-authority.js';
import type { NativeContractDecisionHost } from '../../sdk/src/platform/contract/native-decisions.js';
import { nativeSourcePlan } from '../../sdk/src/platform/contract/native-source.js';
import { plannerOutput, type AnswerContext, type DraftPlan } from './plan-support.js';
import { makeHarness, makeRepo, oneUnitPlan, waitFor, type Harness, type HarnessOptions } from './runner-support.js';
import { finishes, fixPlan, judgeOf, scriptsWith, stepPlanner, terminal } from './steps-support.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
const logs: SqliteDecisionLog[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) {
    const ids = h.runner.list({ includeTerminal: true }).map(contract => contract.id);
    h.dispose();
    await Promise.all(ids.map(id => h.runner.join(id)));
  }
  for (const log of logs.splice(0)) log[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function source(): NativeContractSource {
  return {
    sourceId: 'native-work-union', sourceRevision: 'source-7', inputRevision: 'input-9',
    criteriaId: 'native-criteria-union', criteriaRevision: 'criteria-3',
    goal: '  Preserve the complete native CSV request.\nKeep unicode ☃ and trailing space. ',
    criteria: [' Preserve repeated requirements exactly. ', 'Second requirement\nwith a second line.', ' Preserve repeated requirements exactly. '],
  };
}
function plan(): DraftPlan {
  const original = source();
  const base = oneUnitPlan(original.criteria.length);
  return {
    ...base,
    goal: original.goal,
    criteria: nativeSourcePlan(original).criteria.map(criterion => ({ ...criterion })),
    groups: [{ ...base.groups[0]!, units: [{ ...base.groups[0]!.units[0]!, criteria: original.criteria.map((_text, index) => ({
      id: `u1.c${index + 1}`, text: `Original requirement ${index + 1} holds`, serves: [`c${index + 1}`],
    })) }] }],
  };
}
function authority() { return { authorityId: 'native-host', authorityRevision: 'authority-1', scopeId: 'native-project', scopeRevision: 'scope-1' }; }
function host(extra: Partial<NativeContractDecisionHost> = {}): NativeContractDecisionHost { return { authorityOf: authority, ...extra }; }
function request(root: string): DurableContractRequest {
  const original = source();
  return {
    key: { workId: 'owning-native-work', criteriaId: original.criteriaId, criteriaRevision: original.criteriaRevision, attemptId: 'attempt-1' },
    binding: { sourceId: original.sourceId, inputRevision: original.inputRevision, actionId: 'start-native-contract', actionRevision: 'action-1', ...authority() },
    input: { ask: 'A short display summary without the full requirements.', nativeSource: original, sessionId: 'native-union', origin: 'turn', projectRoot: root, isolation: 'shared' },
  };
}
function setup(options: Partial<HarnessOptions> = {}): Harness {
  const root = options.root ?? makeRepo();
  if (!roots.includes(root)) roots.push(root);
  const h = makeHarness({
    root, recordNative: true, ...(options.recordNative === false ? {} : { nativeDecisions: host() }), plan: plan(), scripts: {},
    durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) }, ...options,
  });
  harnesses.push(h);
  return h;
}
function decisionLog(): SqliteDecisionLog { const log = new SqliteDecisionLog(':memory:'); logs.push(log); return log; }
async function stop(h: Harness, id: string): Promise<void> {
  h.dispose();
  await h.runner.join(id);
  harnesses.splice(harnesses.indexOf(h), 1);
}
function isStage(context: AnswerContext, stage: string): boolean {
  return String((context.state['binding'] as { actionId?: string } | undefined)?.actionId).includes(`:${stage}:`);
}
async function done(h: Harness, id: string): Promise<Contract> {
  await waitFor(() => terminal(h, id), 'native durable terminal result', 15_000);
  await h.runner.join(id);
  return h.store.get(id)!;
}

describe('native semantic and durable admission union', () => {
  test('source-bearing admission preserves exact ordered roots, records native decisions, and replays one execution', async () => {
    const log = decisionLog();
    const invalid = plan(); invalid.criteria[1]!.text = 'A generated weaker replacement';
    const planner = stepPlanner(count => count === 1 ? invalid : plan());
    let actionSource: unknown;
    const h = setup({ decisionLog: log, planner: planner.runner, scripts: { u1: (record, run) => {
      actionSource = h.runner.hooks().actionSource?.(record);
      return finishes('complete original parser')(record, run);
    } } });
    const borrowed = { ...source(), criteria: [...source().criteria] };
    const input = { ...request(h.root), input: { ...request(h.root).input, nativeSource: borrowed } };
    const firstPending = h.runner.startDurable(input);
    borrowed.goal = 'Changed after dispatch'; borrowed.criteria.reverse(); borrowed.criteria[0] = 'Changed after dispatch';
    const [first, ...replays] = await Promise.all([firstPending, ...Array.from({ length: 5 }, () => h.runner.startDurable(request(h.root)))]);
    const id = first!.admission.contractId;
    expect(first!.admission.key.workId).toBe('owning-native-work');
    expect(first!.admission.key.workId).not.toBe(source().sourceId);
    expect(replays.every(replay => replay.admission.contractId === id)).toBe(true);
    const result = await done(h, id);
    expect(result.error).toBeUndefined(); expect(result.status).toBe('passed');
    expect(result.nativeSource).toEqual(source());
    expect(actionSource).toEqual({ goal: source().goal, criteria: [...source().criteria] });
    expect(result.goal).toBe(source().goal);
    expect(result.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, quote: criterion.quote }))).toEqual([...nativeSourcePlan(source()).criteria]);
    expect(result.criteria.every(criterion => criterion.status === 'met' && criterion.readings.length > 0)).toBe(true);
    expect(planner.of('plan')).toHaveLength(2); expect(h.agentsOf('u1')).toHaveLength(1);
    expect(h.manager.list().filter(record => record.contractRole === 'owner')).toHaveLength(1);
    expect(result.nativeDecisions!.spent.plan).toBe(2);
    const decisions = result.nativeDecisions!.history.filter(record => record.stage === 'plan');
    expect(decisions.map(record => record.decision.outcome)).toEqual(['revise', 'act']);
    for (const record of decisions) {
      expect(record.decision.binding).toMatchObject({ sourceId: source().sourceId, inputRevision: source().inputRevision, ...authority() });
      expect(record.decision.judgmentDecisionIds.length).toBeGreaterThan(0);
      for (const id of record.decision.judgmentDecisionIds) expect(log.get(id)).toBeDefined();
    }
    for (const invocation of planner.requests) {
      expect(invocation.userPrompt).toContain(JSON.stringify({ goal: source().goal, criteria: source().criteria }));
      for (const key of ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision']) {
        expect(invocation.userPrompt).not.toContain(`"${key}"`);
      }
    }
    expect(result.escalations).toHaveLength(0);
    expect(h.events.some(event => event.type === 'CONTRACT_ESCALATED' || event.type === 'CONTRACT_OWNER_REPLIED')).toBe(false);
    const replay = await h.runner.startDurable(request(h.root));
    expect(replay.admission).toEqual(first!.admission); expect(replay.state).toBe('terminal');
    expect(planner.requests).toHaveLength(2); expect(h.agentsOf('u1')).toHaveLength(1);
    const disk = JSON.parse(readFileSync(contractPath(h.root, id), 'utf8')) as { schemaVersion: number; contract: Contract };
    const durable = JSON.parse(new DurableContractAdmissions(h.root).checkpoint(request(h.root).key)) as { schemaVersion: number; contract: Contract };
    expect(disk.schemaVersion).toBe(5); expect(disk.contract.schemaVersion).toBe(5);
    expect(durable.schemaVersion).toBe(5); expect(durable.contract.nativeSource).toEqual(source());
    expect(durable.contract.nativeDecisions).toEqual(result.nativeDecisions);
    expect('snapshot' in readContractSnapshot(JSON.stringify(durable))).toBe(true);
  }, 20_000);

  test.each(['binding-source', 'binding-input', 'criteria-id', 'criteria-revision'] as const)(
    'inconsistent %s identity is rejected before owner, boundary, planner or unit launch', async mismatch => {
      let launches = 0; let plannerCalls = 0;
      const h = setup({
        durableAdmission: { withCurrent: (_admission, launch) => { launches++; launch(() => undefined); } },
        planner: { run: async () => { plannerCalls++; throw new Error('Mismatched native source must not reach a planner'); } },
      });
      const base = request(h.root);
      const changed: DurableContractRequest = mismatch === 'binding-source' ? { ...base, binding: { ...base.binding, sourceId: 'other-source' } }
        : mismatch === 'binding-input' ? { ...base, binding: { ...base.binding, inputRevision: 'other-input' } }
        : mismatch === 'criteria-id' ? { ...base, key: { ...base.key, criteriaId: 'other-criteria' } }
        : { ...base, key: { ...base.key, criteriaRevision: 'other-revision' } };
      await expect(h.runner.startDurable(changed)).rejects.toThrow();
      expect(launches).toBe(0); expect(plannerCalls).toBe(0); expect(h.manager.list()).toHaveLength(0);
      expect(new DurableContractAdmissions(h.root).read(changed.key)).toBeNull();
    },
  );

  test.each(['missing-source', 'empty-criteria', 'missing-semantic-owner'] as const)(
    '%s cannot turn durable admission into generated-source or legacy execution', async missing => {
      let launches = 0;
      const h = setup({ ...(missing === 'missing-semantic-owner' ? { recordNative: false } : {}),
        durableAdmission: { withCurrent: (_admission, launch) => { launches++; launch(() => undefined); } } });
      const base = request(h.root);
      const input = missing === 'missing-source' ? { ...base.input, nativeSource: undefined }
        : missing === 'empty-criteria' ? { ...base.input, nativeSource: { ...source(), criteria: [] } } : base.input;
      await expect(h.runner.startDurable({ ...base, input })).rejects.toThrow();
      expect(launches).toBe(0); expect(h.manager.list()).toHaveLength(0);
      expect(new DurableContractAdmissions(h.root).read(base.key)).toBeNull();
    },
  );

  test.each(['source-content', 'source-revision', 'binding'] as const)('same-key replay with changed %s is a conflict without another launch', async mismatch => {
    const h = setup({ contract: { maxActiveContracts: 0 } });
    const base = request(h.root);
    const first = await h.runner.startDurable(base);
    const changed = mismatch === 'binding' ? { ...base, binding: { ...base.binding, authorityRevision: 'authority-2' } }
      : { ...base, input: { ...base.input, nativeSource: mismatch === 'source-content'
        ? { ...source(), criteria: [...source().criteria].reverse().map((text, index) => index === 1 ? `${text} changed` : text) }
        : { ...source(), sourceRevision: 'source-8' } } };
    await expect(h.runner.startDurable(changed)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.manager.list()).toHaveLength(1); expect(h.agentsOf('u1')).toHaveLength(0);
    expect((await h.runner.startDurable(base)).admission).toEqual(first.admission);
  });

  test('generic resume holds a deferred durable fix; explicit resume retains evidence and budgets until a fresh decision', async () => {
    const log = decisionLog();
    let revision = '1'; let waits = 0; let wake: (() => void) | undefined;
    const nativeHost = host({ conditions: (_contract, stage) => stage === 'fix-plan' ? [{
      ref: { id: 'repair-resource', revision }, description: 'Independent repair resource is available',
      current: () => ({ id: 'repair-resource', revision }),
      wait: signal => new Promise<void>((resolve, reject) => { waits++; wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
    }] : [] });
    const planner = stepPlanner(plan(), { fix: () => plannerOutput(fixPlan([{ serves: ['c1', 'c2', 'c3'] }])) });
    const first = setup({ decisionLog: log, nativeDecisions: nativeHost, planner: planner.runner, scripts: { u1: finishes('initial parser evidence') },
      port: context => judgeOf(context) === 'deliverable' ? noulAnswer(0.9)
        : isStage(context, 'fix-plan') && context.name === 'disposition' ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined });
    const admitted = await first.runner.startDurable(request(first.root)); const id = admitted.admission.contractId;
    await waitFor(() => waits === 1, 'durable fix condition registered');
    const prior = structuredClone(first.store.get(id)!);
    const deferred = prior.nativeDecisions!.history.findLast(record => record.stage === 'fix-plan')!;
    expect(deferred.decision.outcome).toBe('defer'); expect(prior.fixRounds).toBe(1);
    expect(prior.criteria.map(criterion => criterion.readings.map(reading => reading.verdict))).toEqual([['unmet'], ['unmet'], ['unmet']]);
    await stop(first, id);
    let plannerCalls = 0; let decisions = 0;
    const second = setup({ root: first.root, decisionLog: log, nativeDecisions: nativeHost,
      planner: { run: async () => { plannerCalls++; throw new Error('Retained native plans cannot be regenerated'); } },
      scripts: scriptsWith({}, unitId => unitId === `${id}.f1.u1` ? finishes('fresh repair evidence') : undefined),
      port: context => { if (context.name === 'disposition') decisions++; return undefined; } });
    const report = await second.runner.resumeAll();
    expect(report.resumed).toHaveLength(0); expect(report.skipped).toContain(id);
    expect(second.manager.list()).toHaveLength(0); expect(plannerCalls).toBe(0); expect(decisions).toBe(0); expect(waits).toBe(1);
    expect((await second.runner.startDurable(request(second.root))).admission).toEqual(admitted.admission);
    expect(second.manager.list()).toHaveLength(0); expect(waits).toBe(1);
    const resumed = await second.runner.resumeDurable(request(second.root).key);
    expect(resumed.admission).toEqual(admitted.admission);
    await waitFor(() => waits === 2, 'explicit durable resume re-registers condition');
    const waiting = second.store.get(id)!;
    expect(waiting.nativeSource).toEqual(prior.nativeSource); expect(waiting.criteria).toEqual(prior.criteria);
    expect(waiting.nativeDecisions!.spent).toEqual(prior.nativeDecisions!.spent);
    expect(waiting.nativeDecisions!.plannerOutputs).toEqual(prior.nativeDecisions!.plannerOutputs);
    expect(waiting.nativeDecisions!.history).toEqual(prior.nativeDecisions!.history);
    expect(waiting.fixRounds).toBe(1); expect(second.agentsOf('u1')).toHaveLength(0);
    expect(second.agentsOf(`${id}.f1.u1`)).toHaveLength(0); expect(plannerCalls).toBe(0); expect(decisions).toBe(0);
    revision = '2'; wake!();
    const result = await done(second, id);
    expect(result.error).toBeUndefined(); expect(result.status).toBe('passed');
    expect(result.nativeSource).toEqual(source()); expect(result.nativeDecisions!.spent).toEqual(prior.nativeDecisions!.spent);
    expect(result.fixRounds).toBe(1); expect(plannerCalls).toBe(0); expect(second.agentsOf('u1')).toHaveLength(0);
    expect(second.agentsOf(`${id}.f1.u1`)).toHaveLength(1);
    expect(result.criteria.map(criterion => criterion.readings.map(reading => reading.verdict))).toEqual([['unmet', 'met'], ['unmet', 'met'], ['unmet', 'met']]);
    const fresh = result.nativeDecisions!.history.findLast(record => record.stage === 'fix-plan')!;
    expect(fresh.decision.outcome).toBe('act'); expect(fresh.decision.decisionId).not.toBe(deferred.decision.decisionId);
    expect(fresh.decision.binding.actionRevision).not.toBe(deferred.decision.binding.actionRevision);
    expect(result.escalations).toHaveLength(0);
  }, 20_000);

  test.each(['missing', 'unchanged'] as const)('explicit resume cannot reuse a deferred decision when its condition is %s', async condition => {
    const log = decisionLog(); let waiting = false;
    const first = setup({ decisionLog: log, nativeDecisions: host({ conditions: (_contract, stage) => stage === 'plan' ? [{
      ref: { id: 'independent-evidence', revision: '1' }, description: 'Independent evidence arrives',
      current: () => ({ id: 'independent-evidence', revision: '1' }),
      wait: signal => new Promise<void>((_resolve, reject) => { waiting = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
    }] : [] }), port: context => isStage(context, 'plan') && context.name === 'disposition' ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined });
    const admitted = await first.runner.startDurable(request(first.root)); const id = admitted.admission.contractId;
    await waitFor(() => waiting, 'initial native plan condition');
    const prior = structuredClone(first.store.get(id)!.nativeDecisions!);
    await stop(first, id);
    let plannerCalls = 0; let semanticReads = 0;
    const second = setup({ root: first.root, decisionLog: log,
      nativeDecisions: host({ conditions: () => condition === 'missing' ? [] : [{
        ref: { id: 'independent-evidence', revision: '1' }, description: 'Independent evidence arrives',
        current: () => ({ id: 'independent-evidence', revision: '1' }), wait: async () => undefined,
      }] }),
      planner: { run: async () => { plannerCalls++; throw new Error('An invalid condition cannot regenerate a native plan'); } },
      port: context => { if (context.name === 'disposition') semanticReads++; return undefined; },
    });
    await second.runner.resumeDurable(request(second.root).key);
    const result = await done(second, id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain(condition === 'missing' ? 're-registered' : 'did not change');
    expect(result.nativeSource).toEqual(source()); expect(result.nativeDecisions!.history).toEqual(prior.history);
    expect(result.nativeDecisions!.spent).toEqual(prior.spent);
    expect(plannerCalls).toBe(0); expect(semanticReads).toBe(0); expect(second.agentsOf('u1')).toHaveLength(0);
  });

  test.each(['missing-source', 'replaced-source', 'reordered-roots'] as const)('explicit resume rejects %s checkpoint before launching anything', async mismatch => {
    const first = setup({ contract: { maxActiveContracts: 0 } });
    const base = request(first.root); const started = await first.runner.startDurable(base);
    await stop(first, started.admission.contractId);
    const admissions = new DurableContractAdmissions(first.root); const admission = admissions.read(base.key)!;
    const envelope = JSON.parse(admissions.checkpoint(base.key)) as { schemaVersion: number; contract: { -readonly [K in keyof Contract]: Contract[K] } };
    if (mismatch === 'missing-source') delete envelope.contract.nativeSource;
    else if (mismatch === 'replaced-source') {
      envelope.contract.nativeSource = { ...source(), goal: 'A different self-consistent source' };
      envelope.contract.goal = envelope.contract.nativeSource.goal;
    } else envelope.contract.criteria.reverse();
    // The authoritative durable envelope is corrupted, not merely the compatibility copy.
    admissions.update(admission, JSON.stringify(envelope));
    let launches = 0;
    const second = setup({ root: first.root, durableAdmission: { withCurrent: (_admission, launch) => { launches++; launch(() => undefined); } } });
    await expect(second.runner.resumeDurable(base.key)).rejects.toThrow();
    expect(launches).toBe(0); expect(second.manager.list()).toHaveLength(0);
  });

  test('native planner and fix planner retain construction-owned captured-input authority and original-owner read checks', async () => {
    const root = makeRepo(); roots.push(root);
    const original = 'dirty captured owner input\n'; writeFileSync(join(root, 'README.md'), original);
    const readPaths: string[] = []; const requests: { kind: 'plan' | 'fix'; workingDir: string }[] = [];
    const filter = async (path: string) => { readPaths.push(path); return path !== join(root, 'private.ts'); };
    let deliverableChecks = 0;
    const h = setup({ root, contract: { isolation: 'worktree' }, readAccessFilter: filter,
      repositoryMap: async directory => { expect(readFileSync(join(directory, 'README.md'), 'utf8')).toBe(original); return 'captured README'; },
      planner: { run: async invocation => {
        const kind = invocation.systemPrompt === buildFixPlannerPrompt() ? 'fix' : 'plan';
        requests.push({ kind, workingDir: invocation.workingDir });
        const authority = getContractInputAuthority(invocation);
        expect(authority).toBeDefined();
        await assertContractInputAuthority(authority!, invocation.workingDir, invocation.signal);
        expect(contractInputAuthoritySourceRoot(authority!)).toBe(root);
        expect(getContractInputAuthority({ ...invocation })).toBeUndefined();
        const path = await authorizeContractInputPath(authority!, 'README.md', filter, invocation.signal);
        expect(readFileSync(path, 'utf8')).toBe(original);
        await expect(authorizeContractInputPath(authority!, 'private.ts', filter, invocation.signal)).rejects.toThrow('access-restricted');
        expect(invocation.workingDir).not.toBe(root);
        expect(invocation.userPrompt).toContain(JSON.stringify({ goal: source().goal, criteria: source().criteria }));
        for (const key of ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision']) {
          expect(invocation.userPrompt).not.toContain(`"${key}"`);
        }
        if (kind === 'plan') writeFileSync(join(root, 'README.md'), 'later owner edit\n');
        else {
          expect(invocation.workingDir).toContain('/contract-planner/');
          expect(readFileSync(join(invocation.workingDir, 'src/csv.ts'), 'utf8')).toBe('initial produced parser\n');
        }
        return { status: 'completed', output: plannerOutput(kind === 'plan' ? plan() : fixPlan([{ serves: ['c1', 'c2', 'c3'] }])), elapsedMs: 1 };
      } },
      scripts: scriptsWith({ u1: finishes('initial produced parser') }, unitId => unitId.endsWith('.f1.u1') ? finishes('corrected produced parser') : undefined),
      port: context => { if (judgeOf(context) !== 'deliverable') return undefined; if (context.name === 'goal') deliverableChecks++; return noulAnswer(deliverableChecks === 1 ? 0.9 : 0.03); },
    });
    const base = request(root);
    const started = await h.runner.startDurable({ ...base, input: { ...base.input, isolation: 'worktree' } });
    const result = await done(h, started.admission.contractId);
    expect(result.error).toBeUndefined(); expect(result.status).toBe('passed');
    expect(requests.map(request => request.kind)).toEqual(['plan', 'fix']);
    expect(requests[0]!.workingDir).not.toBe(requests[1]!.workingDir);
    expect(readPaths).toContain(join(root, 'README.md')); expect(readPaths).toContain(join(root, 'private.ts'));
    for (const request of requests) expect(readPaths).toContain(join(request.workingDir, 'README.md'));
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('later owner edit\n');
    expect(result.nativeSource).toEqual(source()); expect(result.fixRounds).toBe(1);
    expect(result.nativeDecisions!.spent.plan).toBe(1); expect(result.nativeDecisions!.spent[`fix:${result.id}:1`]).toBe(1);
  }, 30_000);
});
