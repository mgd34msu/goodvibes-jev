import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleFleetCommand } from '../../cli/fleet-command.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(args: readonly string[]): CliCommandRuntime {
  const root = makeProjectTempDir('gv-agent-fleet-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['fleet', ...args]),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet CLI command', () => {
  test('parses the fleet command and its aliases', () => {
    expect(parseGoodVibesCli(['fleet', 'attempts', 'list']).command).toBe('fleet');
    expect(parseGoodVibesCli(['fleets', 'attempts', 'list']).command).toBe('fleet');
  });

  test('an unknown top-level subcommand is a usage error', async () => {
    const result = await handleFleetCommand(runtime(['bogus']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts');
  });

  test('attempts list reports no held groups on a fresh engine', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'list']));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No groups are currently held for a winner pick.');
  }, 15000);

  test('attempts (bare) defaults to list', async () => {
    const result = await handleFleetCommand(runtime(['attempts']));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No groups are currently held for a winner pick.');
  }, 15000);

  test('attempts list --json reports an empty groups array', async () => {
    const rt = runtime(['attempts', 'list']);
    const result = await handleFleetCommand({
      ...rt,
      cli: parseGoodVibesCli(['fleet', 'attempts', 'list', '--json']),
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly groups?: unknown };
    expect(payload.ok).toBe(true);
    expect(payload.groups).toEqual([]);
  }, 15000);

  test('attempts pick requires both a groupId and a winnerItemId', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'pick', 'group-1']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts pick');
  });

  test('attempts pick refuses without --yes', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'pick', 'group-1', 'item-1']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('without --yes');
  });

  test('attempts pick surfaces an honest error for an unknown group', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'pick', 'group-1', 'item-1', '--yes']));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('unknown or already-resolved best-of-N group');
  }, 15000);

  test('attempts judge requires a groupId', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'judge']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent fleet attempts judge');
  });

  // The composition root now always wires the provider-backed attempt judge
  // (mirroring the SDK's runtime services), so "no judge is configured" can
  // no longer occur, the honest refusal for this call is the unknown group.
  test('attempts judge refuses an unknown group honestly', async () => {
    const result = await handleFleetCommand(runtime(['attempts', 'judge', 'group-1']));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('unknown or already-resolved best-of-N group: group-1');
  }, 15000);
});
