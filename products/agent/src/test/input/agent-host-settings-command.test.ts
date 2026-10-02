import { describe, expect, test } from 'bun:test';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { describeApprovalAlert } from '../../shell/terminal-focus-mode.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const configDir = makeProjectTempDir('agent-host-text-command');
  const config = new AgentConfigManager({ configDir });
  const out: string[] = [];
  const context = {
    platform: { configManager: config }, print: (text: string) => out.push(text), renderRequest: () => {},
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerOperatorRuntimeCommands(registry);
  const run = (args: string[]) => registry.get('settings')!.handler(args, context);
  const alert = () => describeApprovalAlert({
    callId: 'text-command-test', tool: 'exec', category: 'execute',
    args: { commands: [{ cmd: 'echo private-command' }] }, analysis: {},
  } as never, {
    configGet: (key) => config.get(key as never),
    conversation: { title: 'private task', getTitleSource: () => 'user', getLastUserMessage: () => 'private request' },
  });
  return { config, configDir, out, run, alert };
}

describe('exact notification privacy literals at the text command boundary', () => {
  test('text false opts in, live get agrees, and text true revokes supported details', async () => {
    const { config, configDir, out, run, alert } = fixture();
    expect(JSON.stringify(alert())).not.toContain('private');
    await run(['set', KEY, 'false', '--yes']);
    expect(config.get(KEY)).toBe(false);
    expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(false);
    expect(JSON.stringify(alert())).toContain('private');
    await run(['get', KEY]);
    expect(out.at(-1)).toContain('current false');
    await run(['set', KEY, 'true', '--yes']);
    expect(config.get(KEY)).toBe(true);
    expect(JSON.stringify(alert())).not.toContain('private');
    await run(['get', KEY]);
    expect(out.at(-1)).toContain('current true');
  });

  test.each(['False', 'FALSE', ' false ', '"false"', '0', 'off', 'false extra'])('rejects text %j without coercing privacy permission', async (value) => {
    const { config, out, run } = fixture();
    await run(['set', KEY, value, '--yes']);
    expect(config.get(KEY)).toBe(true);
    expect(out.at(-1)).toContain('literal boolean');
  });

  test('extra positional arguments and absent confirmation do not authorize details; ordinary coercion remains', async () => {
    const { config, out, run } = fixture();
    await run(['set', KEY, 'false', 'extra', '--yes']);
    expect(config.get(KEY)).toBe(true);
    expect(out.at(-1)).toContain('literal boolean');
    await run(['set', KEY, 'false']);
    expect(config.get(KEY)).toBe(true);
    expect(out.at(-1)).toContain('without --yes');
    await run(['set', 'behavior.autoApprove', 'off', '--yes']);
    expect(config.get('behavior.autoApprove')).toBe(false);
    await run(['--yes', 'set', KEY, 'false']);
    expect(config.get(KEY)).toBe(false);
    await run(['reset', KEY, '--yes']);
    expect(config.get(KEY)).toBe(true);
  });
});
