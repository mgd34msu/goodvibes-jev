import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PolicyRegistry, PolicyRuntimeState, createShellPathService, createUnsignedBundle } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture(state = new PolicyRuntimeState(), policyRegistry?: PolicyRegistry) {
  const root = makeProjectTempDir('gv-policy-engine-owner');
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root });
  const out: string[] = [];
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const context = {
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    // Match bootstrap: platform.config is a startup snapshot; configManager stays live.
    platform: { configManager, config: configManager.getAll() },
    extensions: { policyRuntimeState: state, policyRegistry, mcpRegistry: { listServerSecurity: () => [] } },
    print(text: string) { out.push(text); }, renderRequest() {}, exit() {},
  } as unknown as CommandContext;
  return { state, out, context, configManager, commands,
    run: (args: string[]) => commands.get('policy')!.handler(args, context) };
}
function syntheticReadings() {
  return fakePort((name, question) => question.type === 'choice'
    ? choiceAnswer(question, name === 'kind' ? 'other' : 'generic') : noulAnswer(0.03));
}
async function withReadings(run: () => Promise<void>) {
  const { port } = syntheticReadings();
  const previous = installJudgmentPort(port);
  try { await run(); } finally { installJudgmentPort(previous); }
}
function scopedCandidate(state: PolicyRuntimeState) {
  state.getRegistry().loadCandidate(createUnsignedBundle('scoped', { version: 1,
    rules: [{ type: 'path-scope', id: 'scoped-rule', origin: 'user', effect: 'allow', toolPattern: 'read', pathPatterns: ['/fixture/**'] }],
  }));
}
function delayedReadings() {
  let release = () => {}; let started = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const { port } = syntheticReadings();
  const previous = installJudgmentPort({ model: port.model, async ask(request) {
    started(); await waiting; return port.ask(request);
  } });
  return { release, entered, restore: () => { release(); installJudgmentPort(previous); } };
}

describe('registered /policy engine owner', () => {
  test('uses the live configured threshold, including zero, instead of a local constant', async () => {
    await withReadings(async () => {
      const f = fixture();
      for (const threshold of [0.2, 0]) {
        f.configManager.set('permissions.divergenceThreshold', threshold);
        await f.run(['load', `threshold-${threshold}`]);
        await f.run(['simulate', 'silent']);
        expect(f.state.getDashboard()?.checkEnforceGate().threshold).toBe(threshold);
        expect(f.state.getRegistry().getCandidate()?.gateResult?.threshold).toBe(threshold);
        expect(f.state.getSnapshot().lastSimulationSummary?.mode).toBe('simulation-only');
      }
    });
  });
  test('preserves the default threshold and all simulation mode grammar', async () => {
    await withReadings(async () => {
      for (const [argument, mode] of [[undefined, 'warn-on-divergence'], ['silent', 'simulation-only'], ['enforce', 'enforce'], ['unknown', 'warn-on-divergence']] as const) {
        const f = fixture();
        await f.run(['load', 'ordinary']);
        await f.run(argument ? ['sim', argument] : ['simulate']);
        expect(f.state.getDashboard()?.checkEnforceGate().threshold).toBe(0.05);
        expect(f.state.getSnapshot().lastSimulationSummary?.mode).toBe(mode);
      }
    });
  });
  test('keeps /pol registered and opens the actual TUI policy view without reading runtime services', async () => {
    const f = fixture();
    expect(f.commands.get('pol')).toBe(f.commands.get('policy'));
    let opened = 0;
    const context = { openPolicyView() { opened += 1; },
      get extensions(): never { throw new Error('Opening a panel must not inspect policy state'); },
      get platform(): never { throw new Error('Opening a panel must not read config'); },
    } as unknown as CommandContext;
    await f.commands.get('pol')!.handler([], context);
    expect(opened).toBe(1); expect(f.out).toEqual([]);
  });
  test('no panel or an unknown verb retains usage and does not need policy state', async () => {
    const f = fixture();
    for (const args of [[], ['unknown']]) {
      f.out.length = 0;
      await f.commands.get('policy')!.handler(args, { print: f.context.print } as CommandContext);
      expect(f.out.join('\n')).toContain('Usage: /policy <subcommand>');
      expect(f.out.join('\n')).toContain('open the policy/governance modal');
    }
  });
  test('missing policy state and missing shell paths retain their exact errors', async () => {
    const f = fixture();
    await expect(f.commands.get('policy')!.handler(['status'], { ...f.context, extensions: {} } as CommandContext))
      .rejects.toThrow('Policy runtime state is not available in this runtime.');
    await expect(f.commands.get('policy')!.handler(['simulate'], { ...f.context, workspace: {} } as CommandContext))
      .rejects.toThrow('commandContext.workspace.shellPaths is required but was not wired at bootstrap');
  });
  test('ordinary verbs, aliases, blocked promote, explicit force and rollback retain state and explanations', async () => {
    await withReadings(async () => {
      const f = fixture();
      await f.run(['simulate']); expect(f.out.join('\n')).toContain('No candidate bundle loaded');
      await f.run(['load', 'first', '-2']); expect(f.state.getRegistry().getCandidate()?.rules).toHaveLength(0);
      await f.run(['promote']); expect(f.out.join('\n')).toContain('Promotion blocked:');
      await f.run(['simulate']); await f.run(['simulate']); expect(f.out.join('\n')).toContain('Cannot start simulation:');
      await f.run(['trend']); expect(f.out.join('\n')).toContain('Recorded a divergence trend sample');
      await f.run(['promote', '--force']); expect(f.state.getRegistry().getCurrent()?.bundle.bundleId).toBe('first');
      expect(f.out.join('\n')).toContain('WARNING: --force bypasses the divergence gate');
      await f.run(['load', 'second', '1']); await f.run(['lint']); expect(f.out.join('\n')).toContain('[candidate] ERROR second-rule-0');
      await f.run(['diff']); expect(f.out.join('\n')).toContain('Diff: first → second (1 change)');
      await f.run(['st']); expect(f.out.join('\n')).toContain('Candidate: second');
      await f.run(['sim']); await f.run(['promote', '--force']); await f.run(['rb']);
      expect(f.state.getRegistry().getCurrent()?.bundle.bundleId).toBe('first');
      expect(f.state.getDashboard()).toBeNull(); expect(f.out.join('\n')).toContain('Simulation dashboard cleared');
    });
  });
  test('preserves the product-held registry override', async () => {
    const override = new PolicyRegistry(); const f = fixture(new PolicyRuntimeState(), override);
    await f.run(['load', 'override']); expect(override.getCandidate()?.bundle.bundleId).toBe('override');
    expect(f.state.getRegistry().getCandidate()).toBeNull();
  });
  test('preflight reads live config and mapped MCP security without asking the user', async () => {
    const f = fixture(); f.configManager.set('permissions.mode', 'allow-all');
    f.context.extensions.mcpRegistry.listServerSecurity = () => [{ name: 'synthetic-server', connected: false, schemaFreshness: 'fresh', trustMode: 'allow-all', role: 'ops', allowedPaths: [], allowedHosts: [] }];
    f.context.confirm = async () => { throw new Error('Policy inspection must not ask for a semantic decision'); };
    await f.run(['pf']); expect(f.state.getSnapshot().lastPreflightReview?.status).toBe('block');
    expect(f.out.join('\n')).toContain('synthetic-server'); expect(f.out.join('\n')).toContain('Preflight review: BLOCK');
  });
  for (const verb of ['lint', 'preflight'] as const) {
    test(`${verb} awaits readings and discards a late result after candidate replacement`, async () => {
      const f = fixture(); scopedCandidate(f.state); const delayed = delayedReadings();
      try {
        const running = f.run([verb]); await delayed.entered; expect(f.out).toEqual([]);
        f.state.getRegistry().loadCandidate(createUnsignedBundle('replacement', { version: 1, rules: [] }));
        delayed.release(); await running;
        expect(f.out.join('\n')).toContain(`Policy bundles changed while ${verb} was running`);
        expect(f.state.getSnapshot().lastPreflightReview).toBeNull();
      } finally { delayed.restore(); }
    });
  }
  test('clearing a dashboard cancels application of a delayed simulation without resurrecting it', async () => {
    const f = fixture(); await f.run(['load', 'pending']); const delayed = delayedReadings();
    try {
      const running = f.run(['simulate']); await delayed.entered;
      expect(f.state.getSnapshot().lastSimulationSummary).toBeNull(); f.state.setDashboard(null);
      delayed.release(); await running; expect(f.state.getDashboard()).toBeNull();
      expect(f.state.getSnapshot().lastSimulationSummary).toBeNull();
      expect(f.state.getRegistry().getCandidate()?.simulationReport).toBeUndefined();
      expect(f.out.join('\n')).toContain('results were not applied');
    } finally { delayed.restore(); }
  });
  for (const verb of ['simulate', 'lint', 'preflight'] as const) {
    test(`${verb} propagates a cancelled reader without recording a successful result`, async () => {
      const f = fixture(); scopedCandidate(f.state);
      const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { throw new DOMException('Synthetic reader cancelled', 'AbortError'); } });
      try {
        await expect(f.run([verb])).rejects.toThrow('Synthetic reader cancelled');
        expect(f.state.getSnapshot().lastSimulationSummary).toBeNull(); expect(f.state.getSnapshot().lastPreflightReview).toBeNull();
        expect(f.out.join('\n')).not.toContain('Scenario run:'); expect(f.out.join('\n')).not.toContain('Preflight review:');
        expect(f.out.join('\n')).not.toContain('Lint findings');
      } finally { installJudgmentPort(previous); }
    });
  }
});
