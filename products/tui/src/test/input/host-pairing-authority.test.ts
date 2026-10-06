import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { InputTokenizer } from '@goodvibes-jev/engine/sdk/platform/core';
import { CommandRegistry, isDirectOwnerCommandContext, type CommandContext } from '../../input/command-registry.ts';
import { registerHostPairingCommands } from '../../input/commands/host-pairing.ts';
import { HostPairingController } from '../../shell/host-pairing-controller.ts';
import { readTuiHostPairing, tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';
import { interactiveHostPairingFixture, untilPairing } from '../helpers/interactive-host-pairing.ts';

type PairingRequest = { readonly apply: boolean; readonly bootstrapShared: boolean; readonly name: string };
async function withRuntime(run: (runtime: {
  fixture: ReturnType<typeof interactiveHostPairingFixture>;
  registry: CommandRegistry;
  context: CommandContext;
  controller: HostPairingController;
  starts: PairingRequest[];
  printed: string[];
}) => Promise<void>) {
  const fixture = interactiveHostPairingFixture();
  const registry = new CommandRegistry();
  const printed: string[] = [];
  const starts: PairingRequest[] = [];
  const controller = new HostPairingController(fixture.options, {
    print: text => printed.push(text), setPrompt: () => {}, canPresent: () => true, executeOwnerCommand: () => {},
  });
  const context = {
    platform: { configManager: fixture.configManager },
    workspace: { shellPaths: { homeDirectory: fixture.homeDirectory } },
    print: (text: string) => printed.push(text), renderRequest: () => {},
    beginHostPairing: async (request: PairingRequest) => {
      starts.push(request); await controller.start(request);
    },
  } as unknown as CommandContext;
  registerHostPairingCommands(registry);
  try { await run({ fixture, registry, context, controller, starts, printed }); fixture.assertPrivateOutput(printed.join('\n')); }
  finally { controller.dispose(); await fixture.stop(); }
}

function expectUnchanged(fixture: ReturnType<typeof interactiveHostPairingFixture>) {
  expect(fixture.migrations()).toBe(0);
  expect(readTuiHostPairing(fixture.homeDirectory, fixture.host).status).toBe('missing');
  expect(existsSync(tuiHostPairingStorePath(fixture.homeDirectory))).toBe(false);
}

const applyArgs = ['pair', '--bootstrap-shared', '--apply'];

describe('TUI host pairing owner-command authority', () => {
  test('direct owner /host pair opens the live controller and waits for fresh keyboard confirmation', async () => withRuntime(async r => {
    await r.registry.executeFromOwner('host', [...applyArgs, '--name', 'Owner-fixture'], r.context);
    expect(r.starts).toEqual([{ apply: true, bootstrapShared: true, name: 'Owner-fixture' }]);
    expect(r.controller.active).toBe(true);
    expectUnchanged(r.fixture);
    const phrase = r.printed.join('\n').match(/PAIR [0-9a-f]{12}/)![0];
    for (const token of new InputTokenizer().feed(`${phrase}\r`)) r.controller.handleToken(token);
    await untilPairing(() => !r.controller.active, 'direct owner apply');
    expect(r.fixture.migrations()).toBe(1);
    expect(readTuiHostPairing(r.fixture.homeDirectory, r.fixture.host)).toMatchObject({ status: 'paired', name: 'Owner-fixture' });
    expect(isDirectOwnerCommandContext(r.context)).toBe(false);
  }));

  test('direct owner read-only preview has no phrase and creates no store', async () => withRuntime(async r => {
    await r.registry.executeFromOwner('host', ['pair', '--bootstrap-shared'], r.context);
    expect(r.starts).toEqual([{ apply: false, bootstrapShared: true, name: 'GoodVibes TUI' }]);
    expect(r.fixture.authCalls()).toBe(1);
    expect(r.controller.active).toBe(false);
    expect(r.printed.join('\n')).toContain(r.fixture.host);
    expect(r.printed.join('\n')).not.toMatch(/PAIR [0-9a-f]{12}/);
    expectUnchanged(r.fixture);
  }));

  test('direct owner apply does not infer bootstrap selection from a legacy file', async () => withRuntime(async r => {
    await r.registry.executeFromOwner('host', ['pair', '--apply'], r.context);
    expect(r.starts).toEqual([{ apply: true, bootstrapShared: false, name: 'GoodVibes TUI' }]);
    expect(r.fixture.authCalls()).toBe(0);
    expect(r.controller.active).toBe(false);
    expect(r.printed.join('\n')).not.toMatch(/PAIR [0-9a-f]{12}/);
    expectUnchanged(r.fixture);
  }));

  for (const invokedByModel of [undefined, false, true]) {
    test(`ordinary execution cannot apply with invokedByModel=${String(invokedByModel)}`, async () => withRuntime(async r => {
      await r.registry.execute('host', applyArgs, { ...r.context, invokedByModel });
      expect(r.starts).toEqual([]);
      expect(r.controller.active).toBe(false);
      expect(r.fixture.authCalls()).toBe(0);
      expectUnchanged(r.fixture);
    }));
  }

  test('a model context is refused even through the owner entrypoint', async () => withRuntime(async r => {
    await r.registry.executeFromOwner('host', applyArgs, { ...r.context, invokedByModel: true });
    expect(r.starts).toEqual([]);
    expect(r.fixture.authCalls()).toBe(0);
    expectUnchanged(r.fixture);
  }));

  test('direct owner without the live controller capability cannot apply', async () => withRuntime(async r => {
    const { beginHostPairing: _beginHostPairing, ...withoutController } = r.context;
    await r.registry.executeFromOwner('host', applyArgs, withoutController);
    expect(r.starts).toEqual([]);
    expect(r.fixture.authCalls()).toBe(0);
    expectUnchanged(r.fixture);
  }));

  test('public properties cannot forge the private owner-dispatch capability', async () => withRuntime(async r => {
    const forged = { ...r.context, invokedByModel: false, directOwner: true, ownerCommand: true,
      ownerConfirmed: true, isDirectOwnerCommandContext: true };
    expect(isDirectOwnerCommandContext(forged)).toBe(false);
    await r.registry.get('host')!.handler(applyArgs, forged);
    expect(r.starts).toEqual([]);
    expectUnchanged(r.fixture);
  }));

  for (const mode of ['ordinary execution', 'context copy', 'direct handler'] as const) {
    test(`nested ${mode} cannot inherit another owner command's authority`, async () => withRuntime(async r => {
      let relayWasOwner = false;
      r.registry.register({ name: 'relay', description: 'Test nested dispatch', async handler(_args, context) {
        relayWasOwner = isDirectOwnerCommandContext(context);
        if (mode === 'ordinary execution') await r.registry.execute('host', applyArgs, context);
        else await r.registry.get('host')!.handler(applyArgs, mode === 'context copy' ? { ...context } : context);
      } });
      await r.registry.executeFromOwner('relay', [], r.context);
      expect(relayWasOwner).toBe(true);
      expect(r.starts).toEqual([]);
      expect(r.fixture.authCalls()).toBe(0);
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
    await r.registry.get('host')!.handler(applyArgs, captured!);
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
    [...applyArgs, '--yes'], ['pair', '--yes'],
    [...applyArgs, 'PAIR', '000000000000'], [...applyArgs, '--confirmation', 'PAIR 000000000000'],
    [...applyArgs, '--apply'], [...applyArgs, '--bootstrap-shared'], [...applyArgs, '--json'],
    ['pair', '--name'], ['pair', '--name', '--apply'],
    [...applyArgs, '--name', 'One', '--name', 'Two'],
    [...applyArgs, '--name', 'Multiple tokens'], [...applyArgs, '--name', ''],
    [...applyArgs, '--name', 'bad\tname'], [...applyArgs, '--name', 'bad\nname'],
  ]) {
    test(`malformed owner arguments cannot open a grant: ${JSON.stringify(args)}`, async () => withRuntime(async r => {
      await r.registry.executeFromOwner('host', args, r.context);
      expect(r.starts).toEqual([]);
      expect(r.fixture.authCalls()).toBe(0);
      expect(r.controller.active).toBe(false);
      expectUnchanged(r.fixture);
    }));
  }

  for (const args of [['pair'], ['pair', '--bootstrap-shared'], ['pair', '--bootstrap-shared', '--name', 'Passive-fixture']]) {
    test(`non-owner inspection stays local even with bootstrap flags: ${args.join(' ')}`, async () => withRuntime(async r => {
      await r.registry.execute('host', args, r.context);
      expect(r.fixture.authCalls()).toBe(0);
      expect(r.starts).toEqual([]);
      expect(r.controller.active).toBe(false);
      expect(r.printed.join('\n')).not.toMatch(/PAIR [0-9a-f]{12}/);
      expectUnchanged(r.fixture);
    }));
  }
});

// The TUI has no production agent_harness tool. Exercise its actual generic
// registry boundary using the public fields a tool or test harness can supply.
describe('TUI generic tool/harness dispatch boundary', () => {
  for (const args of [applyArgs, [...applyArgs, '--yes'], [...applyArgs, 'PAIR', '000000000000']]) {
    test(`harness confirmation fields cannot replace keyboard provenance: ${args.join(' ')}`, async () => withRuntime(async r => {
      const context = { ...r.context, invokedByModel: true, confirm: true,
        explicitUserRequest: 'Pair this TUI with the host and create persistent administrative access.' } as unknown as CommandContext;
      expect(await r.registry.execute('host', args, context)).toBe(true);
      expect(r.starts).toEqual([]);
      expect(r.controller.active).toBe(false);
      expect(r.fixture.authCalls()).toBe(0);
      expectUnchanged(r.fixture);
    }));
  }

  test('tool command chaining and clearing the public model flag cannot acquire authority', async () => withRuntime(async r => {
    r.registry.register({ name: 'pair-relay', description: 'Test nested host pairing', async handler(_args, context) {
      expect(context.invokedByModel).toBe(true);
      await context.executeCommand!('host', applyArgs);
      await r.registry.get('host')!.handler(applyArgs, { ...context, invokedByModel: false });
    } });
    const context = { ...r.context, invokedByModel: true, confirm: true } as unknown as CommandContext;
    context.executeCommand = (name, args) => r.registry.execute(name, args, context);
    expect(await r.registry.execute('pair-relay', [], context)).toBe(true);
    expect(r.starts).toEqual([]);
    expect(r.fixture.authCalls()).toBe(0);
    expectUnchanged(r.fixture);
  }));

  test('tool inspection cannot contact the host or receive a confirmation phrase', async () => withRuntime(async r => {
    const context = { ...r.context, invokedByModel: true, confirm: true } as unknown as CommandContext;
    expect(await r.registry.execute('host', ['pair', '--bootstrap-shared'], context)).toBe(true);
    expect(r.fixture.authCalls()).toBe(0);
    expect(r.starts).toEqual([]);
    expect(r.printed.join('\n')).not.toMatch(/PAIR [0-9a-f]{12}/);
    expectUnchanged(r.fixture);
  }));
});
