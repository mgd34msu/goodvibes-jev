import { describe, expect, test } from 'bun:test';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { dispatchPolicyCommand } from '../../input/commands/policy-dispatch.ts';
import { createShellPathService, createUnsignedBundle, createPermissionSimulator, DivergenceDashboard } from '@/runtime/index.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { createRuntimeStore, type ContractRecord } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createOperationsReadModels } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import { registerControlRoomRuntimeCommands } from '../../input/commands/control-room-runtime.ts';

// W6 command-path parity: /policy record-trend is a thin wrapper over
// PolicyRuntimeState.recordTrendEntry() (the policy modal dropped its 'r' action
// because the old view called that method directly and /policy had no equivalent
// verb). recordTrendEntry() forwards to the attached DivergencePanel, so the
// verb is honest about needing an active simulation dashboard.

function makeContext(out: string[], policyRuntimeState: PolicyRuntimeState, contracts: readonly ContractRecord[] = []): CommandContext {
  const root = makeProjectTempDir('gv-policy-command');
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root });
  const runtimeStore = createRuntimeStore();
  runtimeStore.setState((state) => ({ contracts: { ...state.contracts, contracts: new Map(contracts.map((contract) => [contract.id, contract])) } }));
  const readModels = createOperationsReadModels({
    runtimeStore,
    get approvalBroker(): never { throw new Error('No approval reads should run during contract inspection'); },
    get sessionBroker(): never { throw new Error('No session reads should run during contract inspection'); },
  });
  return {
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    platform: { configManager, config: configManager.getAll(), readModels },
    extensions: {
      policyRuntimeState,
      mcpRegistry: new McpRegistry({
        sandboxSessions: new SandboxSessionRegistry(root),
        hookDispatcher: { fire: () => { throw new Error('No hooks should run during policy inspection'); } },
      }),
    },
    print: (text: string) => { out.push(text); },
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
}

describe('/policy record-trend', () => {

  test('reports honestly when no simulation dashboard is active (no silent no-op)', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy')!;
    const out: string[] = [];
    // A fresh PolicyRuntimeState has no dashboard attached.
    await policy.handler(['record-trend'], makeContext(out, new PolicyRuntimeState()));
    const printed = out.join('\n');
    expect(printed).toContain('No active simulation dashboard');
    expect(printed).toContain('/policy simulate');
  });

  test("'trend' alias resolves to the same handler", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy')!;
    const out: string[] = [];
    await policy.handler(['trend'], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('No active simulation dashboard');
  });
});

describe('/orchestration contract inspection', () => {
  test('reads the public contracts snapshot and renders units without a synthetic graph', async () => {
    const out: string[] = [];
    const contract: ContractRecord = {
      id: 'contract-1',
      sessionId: 'session-1',
      ask: 'Check the release fixtures',
      status: 'running',
      criteria: [],
      groups: new Map(),
      units: new Map([['unit-1', { id: 'unit-1', groupId: 'group-1', title: 'Read fixtures', status: 'running', verdicts: {}, nudges: 0 }]]),
      nudges: 0,
      openEscalations: [],
      createdAt: 1,
    };
    const commands = new CommandRegistry();
    registerControlRoomRuntimeCommands(commands);
    await commands.get('orchestration')!.handler(['show', contract.id], makeContext(out, new PolicyRuntimeState(), [contract]));
    expect(out.join('\n')).toContain('Contract contract-1');
    expect(out.join('\n')).toContain('request: Check the release fixtures');
    expect(out.join('\n')).toContain('unit-1 unit running Read fixtures');
    expect(out.join('\n')).toContain('/workstream status contract-1');
  });

  test('reports an unknown contract without dereferencing retired graph fields', async () => {
    const out: string[] = [];
    const commands = new CommandRegistry();
    registerControlRoomRuntimeCommands(commands);
    await commands.get('orchestration')!.handler(['show', 'missing'], makeContext(out, new PolicyRuntimeState()));
    expect(out).toEqual(['Unknown contract: missing']);
  });
});

describe('/policy async readers', () => {
  test('load refreshes the actual cached lint snapshot', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    await dispatchPolicyCommand(['load', 'test-candidate', '1'], makeContext(out, state));
    expect(state.getSnapshot().lintFindings).toHaveLength(1);
    expect(state.getSnapshot().lintFindings[0]?.ruleId).toBe('test-candidate-rule-0');
  });

  test('a refresh failure preserves the completed load and reports the separate reader failure', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    const registry = state.getRegistry();
    registry.loadCandidate(createUnsignedBundle('active', {
      version: 1,
      rules: [{ type: 'path-scope', id: 'scoped', origin: 'user', effect: 'allow', toolPattern: 'read', pathPatterns: ['/fixture/**'] }],
    }));
    const simulator = createPermissionSimulator({ mode: 'default' }, { mode: 'default' }, 'simulation-only', {});
    registry.markSimulating();
    registry.attachSimulationReport(simulator.getDivergenceReport(), new DivergenceDashboard(simulator, 'simulation-only', { threshold: 0.05 }).checkEnforceGate());
    expect(registry.promote(true).ok).toBe(true);
    const previous = installJudgmentPort({
      model: 'jev-1.13.0',
      async ask() { throw new Error('Synthetic lint reader unavailable'); },
    });
    try {
      await dispatchPolicyCommand(['load', 'new-candidate'], makeContext(out, state));
      expect(registry.getCandidate()?.bundle.bundleId).toBe('new-candidate');
      expect(registry.getCurrent()?.bundle.bundleId).toBe('active');
      expect(out.join('\n')).toContain('Candidate loaded: new-candidate');
      expect(out.join('\n')).toContain('Policy change applied, but lint findings could not be refreshed');
      expect(out.join('\n')).toContain('Synthetic lint reader unavailable');
      expect(out.join('\n')).not.toContain('Load failed');
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('awaits real lint findings before formatting candidate output', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    const ctx = makeContext(out, state);
    await dispatchPolicyCommand(['load', 'test-candidate', '1'], ctx);
    out.length = 0;

    await dispatchPolicyCommand(['lint'], ctx);

    expect(out.join('\n')).toContain('Lint findings (1)');
    expect(out.join('\n')).toContain('[candidate] ERROR test-candidate-rule-0');
  });

  test('awaits scenario readings before recording their summary', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    const ctx = makeContext(out, state);
    await dispatchPolicyCommand(['load', 'test-candidate'], ctx);
    const { port } = fakePort((name, question) => question.type === 'choice'
      ? choiceAnswer(question, name === 'kind' ? 'other' : 'generic')
      : noulAnswer(0.03));
    const previous = installJudgmentPort(port);
    try {
      await dispatchPolicyCommand(['simulate'], ctx);
      const summary = state.getSnapshot().lastSimulationSummary;
      expect(summary?.totalScenarios).toBeGreaterThan(0);
      expect(out.join('\n')).toContain(`Scenario run: ${summary?.totalScenarios} samples`);
      expect(state.getRegistry().getCandidate()?.state).toBe('promoting');
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('preflight records the completed lint findings', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    const ctx = makeContext(out, state);
    await dispatchPolicyCommand(['load', 'test-candidate', '1'], ctx);
    await dispatchPolicyCommand(['preflight'], ctx);
    expect(state.getSnapshot().lastPreflightReview?.status).toBe('block');
    expect(state.getSnapshot().lastPreflightReview?.issues.some((issue) => issue.source === 'policy')).toBe(true);
    expect(out.join('\n')).toContain('Preflight review: BLOCK');
  });

  test('a delayed scenario run cannot attach its result to a replacement candidate', async () => {
    const out: string[] = [];
    const state = new PolicyRuntimeState();
    const ctx = makeContext(out, state);
    await dispatchPolicyCommand(['load', 'old-candidate'], ctx);
    let release = () => {};
    const pendingRead = new Promise<void>((resolve) => { release = resolve; });
    const { port } = fakePort((name, question) => question.type === 'choice'
      ? choiceAnswer(question, name === 'kind' ? 'other' : 'generic')
      : noulAnswer(0.03));
    const previous = installJudgmentPort({
      model: port.model,
      async ask(request) {
        await pendingRead;
        return port.ask(request);
      },
    });
    try {
      const run = dispatchPolicyCommand(['simulate'], ctx);
      state.getRegistry().loadCandidate(createUnsignedBundle('replacement', { version: 1, rules: [] }));
      release();
      await run;
      expect(state.getRegistry().getCandidate()?.bundle.bundleId).toBe('replacement');
      expect(state.getRegistry().getCandidate()?.state).toBe('loaded');
      expect(state.getSnapshot().lastSimulationSummary).toBeNull();
      expect(out.join('\n')).toContain('results were not applied');
    } finally {
      release();
      installJudgmentPort(previous);
    }
  });
});
