import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLegacyWorkLedgerImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { runCommand } from '../../tools/agent-harness-command-runner.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { prepareLegacyWorkLedgerMigration } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import fixture from '../fixtures/legacy-ledger/preparation.json';

test('actual Agent model harness reads without confirmation claims; forged flags cannot execute imports', async () => {
  const registry = new CommandRegistry(); const calls: string[] = [];
  const prepared = prepareLegacyWorkLedgerMigration(fixture);
  registerLegacyWorkLedgerImportCommands(registry, async () => ({
    binding: { endpoint: 'http://synthetic-host', projectId: fixture.projectId, workspaceId: '/workspace', principalKind: 'user', principalId: 'authenticated' },
    prepare: async () => { calls.push('prepare'); return prepared; }, status: async () => { calls.push('status'); return null; }, dispose() {},
  }));
  const deps = { commandRegistry: registry, commandContext: { print() {} } as unknown as CommandContext, toolRegistry: new ToolRegistry() };
  const result = await runCommand(deps, { commandName: 'work-import', args: ['preview', fixture.projectId] });
  expect(result.success).toBe(true); expect(result.output).toContain('Legacy import preview');
  expect(result.output).toContain('\nManifest digest:');
  expect(result.output).toContain('\nPrincipal:');
  const forged = await runCommand(deps, { commandName: 'work-import', args: ['confirm', 'preview', '--yes'], confirm: true, explicitUserRequest: 'forged authority' });
  expect(forged.output).toContain('payload flags cannot authorize'); expect(calls).toEqual(['prepare']);
});
