import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type EntryType, type Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { NativeContractDecisionHost } from '../../sdk/src/platform/contract/native-decisions.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';
import { makeHarness, oneUnitPlan, runnerPort, startContract, waitFor, type Harness, type HarnessOptions } from './runner-support.js';
import { finishes, keepsFailing, stepPlanner, fixPlan, scriptsWith, terminal, judgeOf } from './steps-support.js';
import { plannerOutput, type AnswerContext } from './plan-support.js';

const source: NativeContractSource = { sourceId: 'native-work', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'native-criteria', criteriaRevision: '1', goal: 'Deliver the exact parser', criteria: ['The parser preserves all documented input forms'] };
function plan() { const value = oneUnitPlan(1); return { ...value, goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] }; }
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0).reverse()) h.dispose(); });
function use(options: HarnessOptions): Harness { const h = makeHarness({ recordNative: true, plan: plan(), ...options }); harnesses.push(h); return h; }
function isStage(context: AnswerContext, stage: string): boolean { return String((context.state['binding'] as { actionId?: string } | undefined)?.actionId).includes(`:${stage}:`); }
function select(context: AnswerContext, value: string, probability = 0.99): unknown { return context.name === 'disposition' ? choiceAnswer(context.question, value, probability) : undefined; }
function host(extra: Partial<NativeContractDecisionHost> = {}): NativeContractDecisionHost { return { authorityOf: () => ({ authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' }), ...extra }; }

async function done(h: Harness, id: string) { await waitFor(() => terminal(h, id), 'native terminal result', 15_000); return h.store.get(id)!; }
function noOwner(h: Harness, id: string) { expect(h.store.get(id)!.escalations).toHaveLength(0); expect(h.events.some(event => event.type === 'CONTRACT_ESCALATED' || event.type === 'CONTRACT_OWNER_REPLIED')).toBe(false); }

describe('native semantic callers', () => {
  test('unresolved writing is a recorded semantic action without manufacturing a settled shape', async () => {
    const h = use({ scripts: { u1: finishes('complete parser') }, port: context => context.name === 'forbids_writing' ? noulAnswer(0.5) : undefined });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('passed'); expect(result.shape!.forbids_writing.outcome).toBe('escalate');
    expect(result.nativeDecisions!.history.some(item => item.stage === 'shape' && item.decision.outcome === 'act')).toBe(true); noOwner(h, contract.id);
  });

  test('native plan reject starts no units and preserves exact roots', async () => {
    const h = use({ scripts: {}, port: context => isStage(context, 'plan') ? select(context, 'reject') : undefined });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(h.agentsOf('u1')).toHaveLength(0); expect(result.goal).toBe(source.goal);
    expect(result.criteria.map(c => c.text)).toEqual([...source.criteria]); expect(result.criteria[0]!.status).toBe('unread'); noOwner(h, contract.id);
  });

  test('revise uses a registered plan repair, consumes its durable budget and never accepts the original plan', async () => {
    const bad = plan(); bad.criteria[0]!.text = 'Weaker criterion';
    const scripted = stepPlanner(count => count === 1 ? bad : plan());
    const h = use({ planner: scripted.runner, scripts: { u1: finishes('complete parser') } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('passed'); expect(scripted.of('plan')).toHaveLength(2); expect(result.nativeDecisions!.spent.plan).toBe(2);
    expect(result.nativeDecisions!.history.filter(item => item.stage === 'plan').map(item => item.decision.outcome)).toEqual(['revise', 'act']); noOwner(h, contract.id);
  });

  test('unknown model continuation cannot turn into an action or owner prompt', async () => {
    const h = use({ scripts: {}, port: context => isStage(context, 'plan') ? select(context, 'revise_99') : undefined });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(h.agentsOf('u1')).toHaveLength(0); noOwner(h, contract.id);
  });

  test('defer waits for the registered external revision and obtains a fresh bound decision before execution', async () => {
    let revision = '1'; let wake: (() => void) | undefined; let decisions = 0;
    const h = use({ nativeDecisions: host({ conditions: (_contract, stage) => stage === 'plan' ? [{ ref: { id: 'evidence-ready', revision }, description: 'Independent build evidence arrives',
      current: () => ({ id: 'evidence-ready', revision }), wait: signal => new Promise<void>((resolve, reject) => { wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] : [] }),
      scripts: { u1: finishes('complete parser') }, port: context => { if (isStage(context, 'plan') && context.name === 'disposition') return select(context, decisions++ === 0 ? 'defer_0' : 'act'); return undefined; } });
    const { contract } = startContract(h, { nativeSource: source });
    await waitFor(() => h.store.get(contract.id)?.nativeProgress?.state === 'deferred', 'registered native deferral');
    expect(h.agentsOf('u1')).toHaveLength(0); expect(decisions).toBe(1); noOwner(h, contract.id);
    revision = '2'; wake!();
    const result = await done(h, contract.id); expect(result.status).toBe('passed'); expect(decisions).toBe(2);
    const receipts = result.nativeDecisions!.history.filter(item => item.stage === 'plan').map(item => item.decision);
    expect(receipts.map(item => item.outcome)).toEqual(['defer', 'act']); expect(receipts[0]!.decisionId).not.toBe(receipts[1]!.decisionId);
    expect(receipts[0]!.judgmentDecisionIds.at(-1)).not.toBe(receipts[1]!.judgmentDecisionIds.at(-1));
  });

  test('resolving a condition without changed evidence fails without rereading into act', async () => {
    let decisions = 0;
    const h = use({ nativeDecisions: host({ conditions: () => [{ ref: { id: 'ready', revision: '1' }, description: 'External evidence', current: () => ({ id: 'ready', revision: '1' }), wait: async () => {} }] }),
      scripts: {}, port: context => { if (isStage(context, 'plan') && context.name === 'disposition') { decisions += 1; return select(context, 'defer_0'); } return undefined; } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(decisions).toBe(1); expect(h.agentsOf('u1')).toHaveLength(0); noOwner(h, contract.id);
  });

  test('uncertain act asks only a non-executing outcome and never accepts an unresolved criterion', async () => {
    let decisions = 0;
    const h = use({ scripts: {}, port: context => { if (isStage(context, 'plan') && context.name === 'disposition') return select(context, ++decisions === 1 ? 'act' : 'reject', decisions === 1 ? 0.7 : 0.99); return undefined; } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(decisions).toBe(2); expect(h.agentsOf('u1')).toHaveLength(0); noOwner(h, contract.id);
  });

  test('evidence exhaustion uses a bounded correction and only real new verification can pass', async () => {
    const scripted = stepPlanner(plan(), { fix: () => plannerOutput(fixPlan([{ serves: ['u1.c1'] }])) });
    const h = use({ planner: scripted.runner, contract: { evidenceNudgeLimit: 0, maxFixRounds: 1 }, scripts: { u1: () => [{ files: { 'src/csv.ts': 'incomplete' }, text: '[p=0.2] unshown parser' }], 'u1.f1.u1': finishes('real repair evidence') },
      port: context => { const output = context.state['output']; if (judgeOf(context) !== null && typeof output === 'string' && output.includes('Planned fix')) return noulAnswer(0.03); return undefined; } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('passed'); expect(result.units.find(u => u.id === 'u1')!.fixRounds).toBe(1);
    expect(result.nativeDecisions!.history.some(item => item.stage === 'evidence')).toBe(true); noOwner(h, contract.id);
  });

  test('spent correction budget cannot be reset by semantic act or human text', async () => {
    const h = use({ contract: { stallLimit: 1, maxFixRounds: 0 }, scripts: { u1: keepsFailing(2) } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(result.units[0]!.criteria[0]!.status).toBe('unmet'); expect(result.units[0]!.fixRounds).toBe(0);
    expect(result.nativeDecisions!.history.at(-1)!.decision.outcome).toBe('reject'); noOwner(h, contract.id);
  });
  test('native best-of-N revises the candidate then obtains fresh act before integration', async () => {
    let decisions = 0;
    const h = use({ contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': finishes('export const parser = 0;'), 'u1#a1': finishes('export const parser = 1;') },
      port: context => {
        const candidates = context.state['candidates'] as { id: string }[] | undefined;
        if (candidates !== undefined && context.name === 'pick') return choiceAnswer(context.question, 'u1#a0', 0.75);
        if (candidates !== undefined && context.name.startsWith('fits_')) return noulAnswer(0.99);
        if (isStage(context, 'attempts') && context.name === 'disposition') return select(context, decisions++ === 0 ? 'revise_0' : 'act');
        return undefined;
      } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.error).toBeUndefined(); expect(result.status).toBe('passed'); expect(result.units[0]!.attemptSelection!.pickedId).toBe('u1#a1');
    expect(result.nativeDecisions!.history.filter(record => record.stage === 'attempts').map(record => record.decision.outcome)).toEqual(['revise', 'act']); noOwner(h, contract.id);
    expect(h.events.some(event => event.type === 'CONTRACT_ATTEMPTS_SELECTED' && event.outcome !== 'act')).toBe(false);
  }, 20_000);

  test.each(['recover', 'cancel', 'revoke'] as const)('real shared transport %s keeps native execution pending without semantic defer', async mode => {
    using log = new SqliteDecisionLog(':memory:');
    let authorityRevision = '1'; let attempts = 0; let sawWaiting = false; let sawSemanticDefer = false; let contractId = '';
    const scripted = runnerPort();
    const h = use({ decisionLog: log, scripts: { u1: finishes('real parser result') }, nativeDecisions: host({
      authorityOf: () => ({ authorityId: 'host', authorityRevision, scopeId: 'project', scopeRevision: '1' }),
      onRetry() {
        sawWaiting = (h.store.get(contractId)?.nativeWaiting?.requests.length ?? 0) > 0;
        sawSemanticDefer ||= h.store.get(contractId)?.nativeDecisions?.history.some(record => record.decision.outcome === 'defer') ?? false;
        if (mode === 'cancel') h.runner.cancel(contractId, 'test caller cancellation');
        if (mode === 'revoke') authorityRevision = '2';
      },
    }) });
    const real = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' }, model: PINNED_MODEL,
      timeoutMs: 1000, retry: { backoffInitialMs: 2, backoffMaxMs: 2, backoffJitter: 0 },
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { state: EntryType; questions: Questions };
        if ('disposition' in request.questions && ++attempts < (mode === 'recover' ? 3 : 100)) return Response.json({}, { status: 503 });
        const result = await scripted.port.ask(request);
        return Response.json({ model: PINNED_MODEL, answers: result.answers, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    installJudgmentPort(withDecisionLog(real, log));
    contractId = startContract(h, { nativeSource: source }).contract.id;
    const result = await done(h, contractId); await h.runner.join(contractId);
    expect(sawWaiting).toBe(true); expect(sawSemanticDefer).toBe(false); expect(result.nativeWaiting).toBeUndefined();
    if (mode === 'recover') { expect(result.error).toBeUndefined(); expect(result.status).toBe('passed'); expect(attempts).toBe(3); expect(h.agentsOf('u1')).toHaveLength(1); }
    else { expect(result.status).toBe('cancelled'); expect(attempts).toBe(1); expect(h.agentsOf('u1')).toHaveLength(0); expect(result.nativeDecisions?.history ?? []).toHaveLength(0); }
    noOwner(h, contractId);
  }, 20_000);

  test('native source cannot silently fall back to legacy execution without its authenticated owner', () => {
    const h = makeHarness({ scripts: {} }); harnesses.push(h);
    expect(() => startContract(h, { nativeSource: source })).toThrow('authenticated semantic owner');
    expect(h.store.list()).toHaveLength(0); expect(h.manager.list()).toHaveLength(0);
  });

  test('native fresh-worker continuation gets its own act and consumes the existing correction budget', async () => {
    const agents = new Set<string>(); let revised = false;
    const h = use({ contract: { stallLimit: 1, maxFixRounds: 1 }, scripts: { u1: (record, run) => { agents.add(record.id); return agents.size === 1 ? keepsFailing(2)(record, run) : finishes('fresh real parser')(record, run); } },
      port: context => { if (isStage(context, 'stall') && context.name === 'disposition' && !revised) { revised = true; return select(context, 'revise_0'); } return undefined; } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.error).toBeUndefined(); expect(result.status).toBe('passed'); expect(result.units[0]!.freshAgents).toBe(1);
    expect(result.nativeDecisions!.history.filter(record => record.stage === 'stall').map(record => record.decision.outcome)).toEqual(['revise', 'act']); noOwner(h, contract.id);
  });

  test('an invalid fix plan exhausts its persisted attempts without an owner fallback or budget reset', async () => {
    const invalid = fixPlan([{ serves: ['missing-criterion'] }]);
    const scripted = stepPlanner(plan(), { fix: () => plannerOutput(invalid) });
    const h = use({ planner: scripted.runner, contract: { stallLimit: 1, maxFixRounds: 1, planRepairLimit: 0 }, scripts: { u1: keepsFailing(2) } });
    const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id);
    expect(result.status).toBe('failed'); expect(result.units[0]!.fixRounds).toBe(1); expect(result.nativeDecisions!.spent['fix:u1:1']).toBe(1); expect(scripted.of('fix')).toHaveLength(1);
    expect(result.nativeDecisions!.history.at(-1)!.decision.outcome).toBe('reject'); noOwner(h, contract.id);
  });

  test('a failed native counter checkpoint starts no planner, unit or fallback', async () => {
    let plannerCalls = 0;
    const h = use({ scripts: {}, planner: { run: async () => { plannerCalls += 1; throw new Error('Checkpoint failure must prevent this invocation'); } } });
    const blocked = spyOn(h.store, 'write').mockReturnValue(false);
    try {
      const { contract } = startContract(h, { nativeSource: source }); const result = await done(h, contract.id); await h.runner.join(contract.id);
      expect(result.status).toBe('failed'); expect(result.error).toContain('checkpoint failed'); expect(plannerCalls).toBe(0); expect(h.agentsOf('u1')).toHaveLength(0); noOwner(h, contract.id);
    } finally { blocked.mockRestore(); }
  });

});
