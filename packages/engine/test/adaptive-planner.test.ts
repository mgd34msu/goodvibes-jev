import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { coreReadingsPort, useCoreReadings } from './_helpers/core-readings.ts';
import { AdaptivePlanner, PlannerJudgmentError, type PlannerInputs } from '../sdk/src/platform/core/adaptive-planner.js';
import type { RawDecomposition } from '../sdk/src/platform/core/plan-proposal.js';

const readings = useCoreReadings({ strategy: 'cohort' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function inputs(overrides: Partial<PlannerInputs> = {}): PlannerInputs {
  return {
    riskScore: 0.2,
    latencyBudgetMs: Infinity,
    isMultiStep: false,
    remoteAvailable: false,
    backgroundEligible: false,
    taskDescription: 'Do the thing',
    ...overrides,
  };
}

describe('AdaptivePlanner.shouldDecompose', () => {
  test('a recorded single strategy holds decomposition even for a multi-step task', async () => {
    readings.set({ strategy: 'single' });
    const planner = new AdaptivePlanner();
    const gate = await planner.shouldDecompose(inputs({ riskScore: 0.9, isMultiStep: true }));
    expect(gate.decompose).toBe(false);
    expect(gate.strategy).toBe('single');
  });

  test('a direct strategy reading gives a single result for a tight-budget task', async () => {
    readings.set({ strategy: 'single' });
    const planner = new AdaptivePlanner();
    const gate = await planner.shouldDecompose(inputs({ riskScore: 0.1, latencyBudgetMs: 1_000, isMultiStep: false }));
    expect(gate.decompose).toBe(false);
    expect(gate.strategy).toBe('single');
  });

  test('a recorded cohort strategy opens decomposition', async () => {
    const planner = new AdaptivePlanner();
    const gate = await planner.shouldDecompose(inputs({ riskScore: 0.2, isMultiStep: true }));
    expect(gate.decompose).toBe(true);
    expect(gate.strategy).toBe('cohort');
  });

  test('reasonCode passthrough matches select() for identical inputs', async () => {
    const planner = new AdaptivePlanner();
    const theInputs = inputs({ riskScore: 0.2, isMultiStep: true });
    const decision = await planner.select(theInputs);
    const gate = await planner.shouldDecompose(theInputs);
    expect(gate.reasonCode).toBe(decision.reasonCode);
    expect(gate.strategy).toBe(decision.selected);
  });
});

describe('AdaptivePlanner.proposeWorkstream', () => {
  test('no raw + gate.decompose=false -> single-item proposal', async () => {
    readings.set({ strategy: 'single' });
    const planner = new AdaptivePlanner();
    const result = await planner.proposeWorkstream(inputs({ riskScore: 0.9, isMultiStep: true, taskDescription: 'Risky task' }));
    expect(result.gate.decompose).toBe(false);
    expect(result.proposal.source).toBe('single-item-fallback');
    expect(result.proposal.task).toBe('Risky task');
    expect(result.issues).toEqual([]);
  });

  test('gate.decompose=true but no raw yet -> honest single-item fallback (not a guess)', async () => {
    const planner = new AdaptivePlanner();
    const result = await planner.proposeWorkstream(inputs({ riskScore: 0.2, isMultiStep: true, taskDescription: 'Multi-step task' }));
    expect(result.gate.decompose).toBe(true);
    expect(result.proposal.source).toBe('single-item-fallback');
  });

  test('raw + gate.decompose=true -> multi-phase planner-agent proposal', async () => {
    const planner = new AdaptivePlanner();
    const raw: RawDecomposition = {
      phases: [{ title: 'Plan' }, { title: 'Build' }],
      workItems: [
        { title: 'Design', brief: 'Design it', phase: 'Plan' },
        { title: 'Code', brief: 'Build it', phase: 'Build', dependsOn: ['Design'] },
      ],
    };
    const result = await planner.proposeWorkstream(
      inputs({ riskScore: 0.2, isMultiStep: true, taskDescription: 'Multi-step task' }),
      raw,
    );
    expect(result.gate.decompose).toBe(true);
    expect(result.proposal.source).toBe('planner-agent');
    expect(result.proposal.phases).toHaveLength(2);
    expect(result.proposal.workItems).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  test('raw supplied even when gate.decompose=false -> still honest single-item fallback (raw ignored)', async () => {
    readings.set({ strategy: 'single' });
    const planner = new AdaptivePlanner();
    const raw: RawDecomposition = {
      phases: [{ title: 'Plan' }],
      workItems: [{ title: 'Design', brief: 'Design it', phase: 'Plan' }],
    };
    const result = await planner.proposeWorkstream(inputs({ riskScore: 0.9, isMultiStep: true }), raw);
    expect(result.proposal.source).toBe('single-item-fallback');
  });

  test('history still appended for every proposeWorkstream call (free audit trail)', async () => {
    const planner = new AdaptivePlanner();
    expect(planner.getLatest()).toBeNull();
    const result = await planner.proposeWorkstream(inputs({ riskScore: 0.2, isMultiStep: true }));
    const latest = planner.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.selected).toBe(result.gate.strategy);
  });
});

describe('AdaptivePlanner purity (import-surface test)', () => {
  test('adaptive-planner.ts uses the judgment port, never direct network, files or agent spawn', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'sdk/src/platform/core/adaptive-planner.ts'),
      'utf-8',
    );
    expect(source).toContain('executionStrategy.run');
    expect(source).toContain('judgmentPort(');
    expect(source).not.toMatch(/readFileSync|writeFileSync|existsSync|mkdirSync/);
    expect(source).not.toMatch(/AgentManager|spawn\(|fetch\(|LLMProvider/);
  });
});


describe('automatic strategy decisions are grounded readings', () => {
  test.each(['single', 'cohort', 'background', 'remote'] as const)('the recorded %s choice controls selection', async (strategy) => {
    readings.set({ strategy });
    const decision = await new AdaptivePlanner().select(inputs({ remoteAvailable: true, backgroundEligible: true }));
    expect(decision.selected).toBe(strategy);
    expect(decision.reasonCode).toBe('JUDGMENT_SELECTED');
    expect(decision.candidates.find((candidate) => candidate.strategy === strategy)?.score).toBe(97);
  });

  test('a high numeric risk does not reinstate the old point ladder', async () => {
    readings.set({ strategy: 'cohort' });
    expect((await new AdaptivePlanner().select(inputs({ riskScore: 0.99, isMultiStep: false }))).selected).toBe('cohort');
  });

  test('an unsettled reading is held explicitly, never silently run as single', async () => {
    readings.set({ strategy: 'cohort', confidence: 0.65 });
    const planner = new AdaptivePlanner();
    await expect(planner.shouldDecompose(inputs())).rejects.toBeInstanceOf(PlannerJudgmentError);
    expect(planner.getLatest()?.selected).toBe('auto');
    expect(planner.getLatest()?.reasonCode).toBe('JUDGMENT_UNSETTLED');
    expect(planner.getLatest()?.outcome).toBe('confirm');
  });

  test.each(['remote', 'background'] as const)('a reading cannot make unavailable %s eligible', async (strategy) => {
    readings.set({ strategy });
    await expect(new AdaptivePlanner().select(inputs())).rejects.toThrow('unavailable capability');
  });

  test('explicit owner override and pinned mode need no model', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      const planner = new AdaptivePlanner();
      planner.setMode('single');
      expect((await planner.select(inputs())).reasonCode).toBe('PINNED_MODE');
      planner.override('cohort');
      expect((await planner.select(inputs())).selected).toBe('cohort');
      planner.clearOverride();
      planner.setMode('auto');
      await expect(planner.select(inputs())).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally { installJudgmentPort(previous); }
  });

  test('cancellation and an owner override arriving during a reading cannot publish a stale choice', async () => {
    const fixture = coreReadingsPort({ strategy: 'cohort' });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const previous = installJudgmentPort({ ...fixture.port, ask: async (request) => { await pending; return fixture.port.ask(request); } });
    try {
      const planner = new AdaptivePlanner();
      const selecting = planner.select(inputs());
      planner.override('single');
      release();
      expect((await selecting).selected).toBe('single');
      expect(planner.getLatest()?.overrideActive).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await expect(planner.select(inputs(), { signal: controller.signal })).rejects.toThrow();
    } finally { installJudgmentPort(previous); }
  });
});
