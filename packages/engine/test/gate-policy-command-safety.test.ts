import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { GoodVibesConfig } from '../sdk/src/platform/config/schema-types.ts';
import { runPolicyCommand, type PolicyFrontDoorContext } from '../sdk/src/platform/gate/policy/policy-command.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { createUnsignedBundle } from '../sdk/src/platform/runtime/permissions/policy-loader.ts';
import { createPermissionSimulator } from '../sdk/src/platform/runtime/permissions/index.ts';
import { DivergenceDashboard } from '../sdk/src/platform/runtime/permissions/divergence-dashboard.ts';

function fixture() {
  const state = new PolicyRuntimeState();
  const out: string[] = [];
  const context: PolicyFrontDoorContext = {
    policyRuntimeState: state, print: (line) => { out.push(line); },
    workingDirectory: () => '/fixture',
    config: () => ({ permissions: { mode: 'default', rules: [], divergenceThreshold: 0.2 } } as unknown as GoodVibesConfig),
    listMcpServerSecurity: () => [],
  };
  return { state, out, run: (args: string[]) => runPolicyCommand(args, context) };
}

function activate(state: PolicyRuntimeState, id: string): void {
  const registry = state.getRegistry();
  registry.loadCandidate(createUnsignedBundle(id, { version: 1, rules: [] }));
  registry.markSimulating();
  const simulator = createPermissionSimulator({ mode: 'default' }, { mode: 'default' }, 'simulation-only', {});
  registry.attachSimulationReport(simulator.getDivergenceReport(), new DivergenceDashboard(simulator, 'simulation-only', {}).checkEnforceGate());
  expect(registry.promote(true).ok).toBe(true);
}

function delayReader() {
  let release = () => {}; let started = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const { port } = fakePort((name, question) => question.type === 'choice'
    ? choiceAnswer(question, name === 'kind' ? 'other' : 'generic') : noulAnswer(0.03));
  const previous = installJudgmentPort({ model: port.model, async ask(request) {
    started(); await pending; return port.ask(request);
  } });
  return { release, entered, restore() { release(); installJudgmentPort(previous); } };
}

describe('public policy owner preserves completed mutations and stale-read guards', () => {
  for (const verb of ['load', 'promote', 'rollback'] as const) {
    test(`${verb} reports its completed mutation separately from a failed lint refresh`, async () => {
      const f = fixture();
      activate(f.state, 'first');
      if (verb === 'rollback') activate(f.state, 'second');
      if (verb === 'promote') {
        f.state.getRegistry().loadCandidate(createUnsignedBundle('second', { version: 1, rules: [] }));
        f.state.getRegistry().markSimulating();
        const simulator = createPermissionSimulator({ mode: 'default' }, { mode: 'default' }, 'simulation-only', {});
        f.state.getRegistry().attachSimulationReport(simulator.getDivergenceReport(), new DivergenceDashboard(simulator, 'simulation-only', {}).checkEnforceGate());
      }
      let notifications = 0;
      const unsubscribe = f.state.subscribe(() => { notifications += 1; });
      f.state.refreshLint = async () => { throw new Error('Synthetic lint unavailable'); };
      try {
        await f.run(verb === 'load' ? ['load', 'second'] : verb === 'promote' ? ['promote', '--force'] : ['rollback']);
        if (verb === 'load') expect(f.state.getRegistry().getCandidate()?.bundle.bundleId).toBe('second');
        else expect(f.state.getRegistry().getCurrent()?.bundle.bundleId).toBe(verb === 'promote' ? 'second' : 'first');
        expect(notifications).toBeGreaterThan(0);
        expect(f.out.at(-1)).toBe('[policy] Policy change applied, but lint findings could not be refreshed: Synthetic lint unavailable');
        expect(f.out.join('\n')).not.toContain('Load failed:');
        expect(f.out.join('\n')).not.toContain('Promotion blocked:');
        expect(f.out.join('\n')).not.toContain('Rollback failed:');
        if (verb === 'rollback') expect(f.state.getDashboard()).toBeNull();
      } finally { unsubscribe(); }
    });
  }

  for (const verb of ['lint', 'preflight', 'simulate'] as const) {
    test(`${verb} does not apply or report a successful late result to a replacement candidate`, async () => {
      const f = fixture();
      f.state.getRegistry().loadCandidate(createUnsignedBundle('old', { version: 1, rules: [
        { type: 'path-scope', id: 'old-rule', origin: 'user', effect: 'allow', toolPattern: 'read', pathPatterns: ['/fixture/**'] },
      ] }));
      const delayed = delayReader();
      try {
        const running = f.run([verb]); await delayed.entered;
        f.state.getRegistry().loadCandidate(createUnsignedBundle('replacement', { version: 1, rules: [] }));
        delayed.release(); await running;
        expect(f.state.getRegistry().getCandidate()?.state).toBe('loaded');
        expect(f.state.getSnapshot().lastSimulationSummary).toBeNull();
        expect(f.state.getSnapshot().lastPreflightReview).toBeNull();
        expect(f.state.getSnapshot().lintFindings).toEqual([]);
        expect(f.out.join('\n')).toContain(verb === 'simulate' ? 'results were not applied' : `Policy bundles changed while ${verb} was running`);
        expect(f.out.join('\n')).not.toContain('Scenario run:');
        expect(f.out.join('\n')).not.toContain('Preflight review:');
        expect(f.out.join('\n')).not.toContain('No lint findings');
      } finally { delayed.restore(); }
    });
  }
});

describe('public policy preflight lint cache', () => {
  function lintErrorBundle(id: string) {
    return createUnsignedBundle(id, { version: 1, rules: [
      { type: 'prefix', id: `${id}-rule`, origin: 'user' as const, effect: 'allow' as const, toolPattern: '*', commandPrefixes: [] },
    ] });
  }

  test('successful preflight publishes matching lint cache and review', async () => {
    const f = fixture();
    f.state.getRegistry().loadCandidate(lintErrorBundle('current'));
    await f.run(['preflight']);
    expect(f.state.getSnapshot().lintFindings).toHaveLength(1);
    expect(f.state.getSnapshot().lintFindings[0]?.ruleId).toBe('current-rule');
    expect(f.state.getSnapshot().lastPreflightReview?.issues.some((issue) => issue.source === 'policy')).toBe(true);
  });

  test('a stale refresh cannot overwrite a newer lint cache or notify its stale findings', async () => {
    const f = fixture();
    f.state.getRegistry().loadCandidate(createUnsignedBundle('old', { version: 1, rules: [
      { type: 'path-scope', id: 'old-rule', origin: 'user', effect: 'allow', toolPattern: 'read', pathPatterns: ['/fixture/**'] },
    ] }));
    const delayed = delayReader();
    try {
      const stale = f.state.refreshLint();
      await delayed.entered;
      f.state.getRegistry().loadCandidate(lintErrorBundle('newer'));
      await f.state.refreshLint();
      expect(f.state.getSnapshot().lintFindings[0]?.ruleId).toBe('newer-rule');
      let notifications = 0;
      const unsubscribe = f.state.subscribe(() => { notifications += 1; });
      try {
        delayed.release(); await stale;
        expect(f.state.getSnapshot().lintFindings[0]?.ruleId).toBe('newer-rule');
        expect(notifications).toBe(0);
      } finally { unsubscribe(); }
    } finally { delayed.restore(); }
  });

  test('reader cancellation leaves the prior lint cache and preflight review unchanged', async () => {
    const f = fixture();
    f.state.getRegistry().loadCandidate(lintErrorBundle('previous'));
    await f.run(['preflight']);
    const before = f.state.getSnapshot();
    expect(before.lintFindings).toHaveLength(1);
    f.state.getRegistry().loadCandidate(createUnsignedBundle('cancelled', { version: 1, rules: [
      { type: 'path-scope', id: 'cancelled-rule', origin: 'user', effect: 'allow', toolPattern: 'read', pathPatterns: ['/fixture/**'] },
    ] }));
    const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { throw new DOMException('Synthetic reader cancelled', 'AbortError'); } });
    try {
      await expect(f.run(['preflight'])).rejects.toThrow('Synthetic reader cancelled');
      expect(f.state.getSnapshot().lintFindings).toEqual(before.lintFindings);
      expect(f.state.getSnapshot().lastPreflightReview).toEqual(before.lastPreflightReview);
    } finally { installJudgmentPort(previous); }
  });
});
