import { startPeriodicSelfUpdate } from '../../runtime/periodic-update.ts';
import { describe, expect, test } from 'bun:test';
import { selfUpdateAtLaunch } from '../../cli/launch-auto-update.ts';
import { registerUpdateCommand } from '../../input/commands/update-runtime.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { fallbackUpdateCommand } from '../../runtime/update-check.ts';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_REBUILD_COMMAND, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';

describe('private workspace distribution', () => {
  test('launch returns guidance before touching host/configuration inputs', async () => {
    const params = new Proxy({}, { get() { throw new Error('launch must not inspect host state'); } });
    expect(IS_WORKSPACE_DISTRIBUTION).toBe(true);
    expect(await selfUpdateAtLaunch(params as Parameters<typeof selfUpdateAtLaunch>[0])).toEqual([WORKSPACE_UPDATE_GUIDANCE]);
  });
  test.each(['check', 'apply', 'rollback'])('/update %s returns guidance before accessing runtime or network inputs', async action => {
    const lines: string[] = [];
    const registry = new CommandRegistry();
    registerUpdateCommand(registry);
    const context = new Proxy({ print: (text: string) => lines.push(text) }, { get(target, property, receiver) {
      if (property === 'print') return Reflect.get(target, property, receiver);
      throw new Error('update must not inspect runtime inputs');
    } });
    await registry.execute('update', [action], context as unknown as CommandContext);
    expect(lines).toEqual([WORKSPACE_UPDATE_GUIDANCE]);
  });
  test('all install-kind guidance names this workspace rebuild', () => {
    expect(fallbackUpdateCommand('source')).toBe(WORKSPACE_REBUILD_COMMAND);
    expect(fallbackUpdateCommand('bun-global-package')).toBe(WORKSPACE_REBUILD_COMMAND);
  });
});


test('a private Agent does not start an hourly release probe or inspect live inputs', () => {
  const params = new Proxy({}, { get() { throw new Error('periodic updates must not inspect host inputs'); } });
  const stop = startPeriodicSelfUpdate(params as Parameters<typeof startPeriodicSelfUpdate>[0]);
  expect(stop).toBeFunction();
  expect(() => stop()).not.toThrow();
});
