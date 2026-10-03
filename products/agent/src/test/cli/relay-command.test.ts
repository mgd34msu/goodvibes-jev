import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function runRelayCli(args: readonly string[], workingDirectory: string, homeDirectory: string) {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory,
      homeDirectory,
    });
    return { result, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('relay CLI command', () => {
  test('parses the relay command', () => {
    expect(parseGoodVibesCli(['relay', 'status']).command).toBe('relay');
  });

  test('status reports the stock default-on config and is explicit that it is not a live check', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');

    const { result, output } = await runRelayCli(['relay', 'status'], work, home);
    expect(result.exitCode).toBe(0);
    // relay.enabled defaults true now (dissolved feature model, default-on).
    expect(output).toContain('relay.enabled: true');
    expect(output).toContain('not live-verified');
  });

  test('status --output-format=json reports the honest liveVerified:false shape', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');

    const { result, output } = await runRelayCli(['relay', 'status', '--output-format=json'], work, home);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(output) as { liveVerified: boolean; config: { enabled: boolean }; flag: { id: string } };
    // Config state is honestly reported, but never presented as live relay
    // registration, that belongs to the daemon holding the relay identity.
    expect(parsed.liveVerified).toBe(false);
    expect(parsed.config.enabled).toBe(true);
    expect(parsed.flag.id).toBe('relay-connect');
  });

  test('pair honestly refuses rather than fabricating a pairing payload', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');

    const { result, output } = await runRelayCli(['relay', 'pair'], work, home);
    expect(result.exitCode).toBe(1);
    expect(output).toContain('cannot mint a relay pairing payload');
  });

  test('unknown relay subcommand is a usage error, not a silent success', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');

    const { result, output } = await runRelayCli(['relay', 'bogus'], work, home);
    expect(result.exitCode).toBe(2);
    expect(output).toContain('Unknown relay subcommand');
  });

});
