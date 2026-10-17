import { describe, expect, test } from 'bun:test';
import { InputTokenizer } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import { CommandRegistry, isDirectOwnerCommandContext, type CommandContext } from '../../input/command-registry.ts';
import { registerOnboardingRuntimeCommands } from '../../input/commands/onboarding-runtime.ts';
import { SetupPairingController } from '../../shell/setup-pairing-controller.ts';
import { readAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { researchScreeningFixture, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { setupPairingFixture, untilPairing } from '../helpers/setup-pairing-fixture.ts';

async function withRuntime(run: (runtime: {
  fixture: ReturnType<typeof setupPairingFixture>;
  registry: CommandRegistry;
  context: CommandContext;
  controller: SetupPairingController;
  starts: Array<{ readonly apply: boolean; readonly name: string }>;
  printed: string[];
  runHarness: (args: Record<string, unknown>) => Promise<ToolResult>;
}) => Promise<void>) {
  const fixture = setupPairingFixture();
  const registry = new CommandRegistry();
  const printed: string[] = [];
  const starts: Array<{ readonly apply: boolean; readonly name: string }> = [];
  const controller = new SetupPairingController(fixture.options, {
    print: text => printed.push(text), setPrompt: () => {}, canPresent: () => true, executeOwnerCommand: () => {},
  });
  const context = {
    platform: { configManager: fixture.configManager },
    workspace: { shellPaths: { homeDirectory: fixture.homeDirectory } },
    print: (text: string) => printed.push(text), renderRequest: () => {},
    beginSetupPairing: async (request: { readonly apply: boolean; readonly name: string }) => {
      starts.push(request); await controller.start(request);
    },
  } as unknown as CommandContext;
  registerOnboardingRuntimeCommands(registry);
  await fixture.configManager.flushConfigFileChanges();
  const manager = new PermissionManager(undefined, createPermissionConfigReader(fixture.configManager), new PolicyRuntimeState());
  const tools = new ToolRegistry(manager), screening = researchScreeningFixture();
  bindAgentResearchSourceOwner(tools, screening.owner);
  registerAgentHarnessTool(tools, registry, context);
  const scripted = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(name === 'mutates' ? 0.999 : 0.001);
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.999);
    if (name === 'kind') return choiceAnswer(question, 'other', 0.999);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.999);
    throw new Error(`Unscripted native pairing fixture question ${name}`);
  });
  const log = new SqliteDecisionLog(':memory:');
  const previous = installJudgmentPort(withDecisionLog(scripted.port, log));
  let sequence = 0;
  const source = { goal: 'Exercise the exact fixture command without acquiring keyboard owner authority.',
    criteria: ['Preserve the native owner-only pairing phrase and unchanged fixture credential store.'] };
  const sourceOf = () => source;
  const runHarness = async (args: Record<string, unknown>) => {
    await manager.prepareAutonomousOwner();
    const callId = `pairing-model-${++sequence}`;
    const preparation = manager.autonomousPreparation(callId, sourceOf);
    const call = await tools.prepareCall(callId, 'agent_harness', args,
      { port: preparation.port, assertCurrent: preparation.assertCurrent });
    const admission = await manager.admitAutonomous(callId, call.name, call.args, { sourceOf,
      schemaRevision: call.schemaRevision, preparedCall: { registry: tools, call } });
    expect(admission.result.approved).toBe(true);
    const result = await tools.executePrepared(call, admission);
    fixture.assertPrivateOutput(JSON.stringify(scripted.requests));
    fixture.assertPrivateOutput(result.output ?? '');
    expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
    return result;
  };
  try { await run({ fixture, registry, context, controller, starts, printed, runHarness }); fixture.assertPrivateOutput(printed.join('\n')); }
  finally {
    controller.dispose(); await fixture.stop(); await cleanupResearchScreeningFixtures();
    installJudgmentPort(previous); log[Symbol.dispose]();
  }
}

function expectUnchanged(fixture: ReturnType<typeof setupPairingFixture>) {
  expect(fixture.migrations()).toBe(0);
  expect(readAgentHostPairing(fixture.homeDirectory, fixture.host).status).toBe('missing');
}

describe('setup pairing owner-command authority', () => {
  for (const name of ['setup', 'onboarding']) {
    test(`direct owner /${name} opens the live controller but still waits for a new phrase`, async () => withRuntime(async r => {
      await r.registry.executeFromOwner(name, ['pair', '--name', 'Owner fixture', '--apply'], r.context);
      expect(r.starts).toEqual([{ apply: true, name: 'Owner fixture' }]);
      expect(r.controller.active).toBe(true);
      expectUnchanged(r.fixture);
      const phrase = r.printed.join('\n').match(/PAIR [0-9a-f]{12}/)![0];
      for (const token of new InputTokenizer().feed(`${phrase}\r`)) r.controller.handleToken(token);
      await untilPairing(() => !r.controller.active, 'direct owner apply');
      expect(r.fixture.migrations()).toBe(1);
      expect(readAgentHostPairing(r.fixture.homeDirectory, r.fixture.host)).toMatchObject({ status: 'paired', name: 'Owner fixture' });
      expect(isDirectOwnerCommandContext(r.context)).toBe(false);
    }));
  }

  for (const invokedByModel of [undefined, false, true]) {
    test(`ordinary execution cannot apply with invokedByModel=${String(invokedByModel)}`, async () => withRuntime(async r => {
      await r.registry.execute('setup', ['pair', '--apply'], { ...r.context, invokedByModel });
      expect(r.starts).toEqual([]);
      expect(r.controller.active).toBe(false);
      expect(r.fixture.authCalls()).toBe(0);
      expectUnchanged(r.fixture);
    }));
  }

  test('a model context is refused even through the owner entrypoint', async () => withRuntime(async r => {
    await r.registry.executeFromOwner('setup', ['pair', '--apply'], { ...r.context, invokedByModel: true });
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
  }));

  test('direct owner without the live controller capability cannot apply', async () => withRuntime(async r => {
    const { beginSetupPairing: _beginSetupPairing, ...withoutController } = r.context;
    await r.registry.executeFromOwner('setup', ['pair', '--apply'], withoutController);
    expect(r.starts).toEqual([]);
    expect(r.fixture.authCalls()).toBe(0);
    expectUnchanged(r.fixture);
  }));

  test('public properties cannot forge the private owner-dispatch capability', async () => withRuntime(async r => {
    const forged = { ...r.context, invokedByModel: false, directOwner: true, ownerCommand: true, isDirectOwnerCommandContext: true };
    expect(isDirectOwnerCommandContext(forged)).toBe(false);
    await r.registry.get('setup')!.handler(['pair', '--apply'], forged);
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
  }));

  for (const mode of ['ordinary execution', 'context copy', 'direct handler'] as const) {
    test(`nested ${mode} cannot inherit another owner command's authority`, async () => withRuntime(async r => {
      let relayWasOwner = false;
      r.registry.register({ name: 'relay', description: 'Test nested dispatch', async handler(_args, context) {
        relayWasOwner = isDirectOwnerCommandContext(context);
        if (mode === 'ordinary execution') await r.registry.execute('setup', ['pair', '--apply'], context);
        else await r.registry.get('setup')!.handler(['pair', '--apply'], mode === 'context copy' ? { ...context } : context);
      } });
      await r.registry.executeFromOwner('relay', [], r.context);
      expect(relayWasOwner).toBe(true);
      expect(r.starts).toEqual([]);
      expectUnchanged(r.fixture);
    }));
  }

  test('nested ordinary dispatch strips authority but leaves the outer context intact', async () => withRuntime(async r => {
    const seen: boolean[] = [];
    r.registry.register({ name: 'inner', description: 'Test inner dispatch', handler(_args, context) { seen.push(isDirectOwnerCommandContext(context)); } });
    r.registry.register({ name: 'outer', description: 'Test outer dispatch', async handler(_args, context) {
      seen.push(isDirectOwnerCommandContext(context));
      await r.registry.execute('inner', [], context);
      seen.push(isDirectOwnerCommandContext(context));
    } });
    await r.registry.executeFromOwner('outer', [], r.context);
    expect(seen).toEqual([true, false, true]);
  }));

  test('owner capability expires when the original dispatch returns', async () => withRuntime(async r => {
    let captured: CommandContext | undefined;
    r.registry.register({ name: 'capture', description: 'Capture a test context', handler(_args, context) { captured = context; } });
    await r.registry.executeFromOwner('capture', [], r.context);
    expect(captured).toBeDefined();
    expect(isDirectOwnerCommandContext(captured!)).toBe(false);
    await r.registry.get('setup')!.handler(['pair', '--apply'], captured!);
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
  }));

  test('owner capability expires when the handler throws', async () => withRuntime(async r => {
    let captured: CommandContext | undefined;
    r.registry.register({ name: 'throwing', description: 'Throw from a test context', handler(_args, context) {
      captured = context; throw new Error('synthetic handler failure');
    } });
    await expect(r.registry.executeFromOwner('throwing', [], r.context)).rejects.toThrow('synthetic handler failure');
    expect(isDirectOwnerCommandContext(captured!)).toBe(false);
  }));

  for (const args of [
    ['pair', '--apply', '--yes'], ['pair', '--yes'],
    ['pair', '--apply', 'PAIR', '000000000000'], ['pair', '--apply', '--confirmation', 'PAIR 000000000000'],
    ['pair', '--apply', '--apply'], ['pair', '--apply', '--json'],
    ['pair', '--name'], ['pair', '--name', '--apply'],
    ['pair', '--name', 'GoodVibes Agent', '--name', 'again', '--apply'],
  ]) {
    test(`malformed owner arguments cannot open a grant: ${args.join(' ')}`, async () => withRuntime(async r => {
      await r.registry.executeFromOwner('setup', args, r.context);
      expect(r.starts).toEqual([]);
      expect(r.fixture.authCalls()).toBe(0);
      expect(r.controller.active).toBe(false);
      expectUnchanged(r.fixture);
    }));
  }

  test('non-owner preview is read-only and does not open the owner controller', async () => withRuntime(async r => {
    await r.registry.execute('setup', ['pair', '--name', 'Preview fixture'], r.context);
    expect(r.fixture.authCalls()).toBe(1);
    expect(r.starts).toEqual([]);
    expect(r.controller.active).toBe(false);
    expect(r.printed.join('\n')).toContain(r.fixture.host);
    expect(r.printed.join('\n')).not.toMatch(/PAIR [0-9a-f]{12}/);
    expectUnchanged(r.fixture);
  }));
});

describe('actual agent_harness pairing boundary', () => {
  for (const args of [['pair', '--apply'], ['pair', '--apply', '--yes'], ['pair', '--apply', 'PAIR', '000000000000']]) {
    test(`harness confirmation flags cannot replace keyboard confirmation: ${args.join(' ')}`, async () => withRuntime(async r => {
      const result = await r.runHarness({ mode: 'run_command', commandName: 'setup', args,
        confirm: true, explicitUserRequest: 'Pair this Agent with the host and create persistent administrative access.' });
      expect(result.success).toBe(true); // Command execution succeeds; the command reports its refusal.
      expect(r.starts).toEqual([]);
      expect(r.controller.active).toBe(false);
      expect(r.fixture.authCalls()).toBe(0);
      expectUnchanged(r.fixture);
      r.fixture.assertPrivateOutput(result.output ?? '');
    }));
  }

  test('harness command chaining cannot acquire an owner capability', async () => withRuntime(async r => {
    let modelContext = false;
    r.registry.register({ name: 'pair-relay', description: 'Test nested setup', async handler(_args, context) {
      modelContext = context.invokedByModel === true;
      await context.executeCommand!('setup', ['pair', '--apply']);
      // A wrapper clearing the public flag still cannot forge provenance.
      await r.registry.get('setup')!.handler(['pair', '--apply'], { ...context, invokedByModel: false });
    } });
    const result = await r.runHarness({ mode: 'run_command', commandName: 'pair-relay',
      confirm: true, explicitUserRequest: 'Run the nested pairing helper.' });
    expect(result.success).toBe(true);
    expect(modelContext).toBe(true);
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
  }));

  test('harness can read a preview without receiving an action-time phrase', async () => withRuntime(async r => {
    const result = await r.runHarness({ mode: 'run_command', commandName: 'setup', args: ['pair'],
      confirm: true, explicitUserRequest: 'Preview the selected host pairing.' });
    expect(result.success).toBe(true);
    expect(result.output).toContain(r.fixture.host);
    expect(result.output).not.toMatch(/PAIR [0-9a-f]{12}/);
    expect(r.fixture.authCalls()).toBe(1);
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
    r.fixture.assertPrivateOutput(result.output ?? '');
  }));
});
