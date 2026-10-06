/** Actual product entry surface, without starting unrelated full-screen services. */
import { strict as assert } from 'node:assert';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { IMPORT_FIXTURE_TOKEN } from './legacy-import-host-fixture.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { beginAgentHostPairing, completeAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { CommandRegistry as AgentRegistry, type CommandContext as AgentContext } from '../../input/command-registry.ts';
import { registerLegacyWorkLedgerImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { runCommand } from '../../tools/agent-harness-command-runner.ts';

export interface ImportProofSelection { home: string; workspace: string; baseUrl: string }
export async function pairImportProofHost(selection: ImportProofSelection): Promise<void> {
  const attemptId = crypto.randomUUID(); const name = 'Owned legacy import product fixture';
  assert.deepEqual(await beginAgentHostPairing(selection.home, selection.baseUrl, { attemptId, name, startedAt: 1 }), { status: 'begun' });
  assert.deepEqual(await completeAgentHostPairing(selection.home, selection.baseUrl, attemptId, { token: IMPORT_FIXTURE_TOKEN, tokenId: 'synthetic-paired-owner', name, createdAt: 2 }), { status: 'paired' });
}
function context(selection: ImportProofSelection, print: (line: string) => void) {
  return { print, platform: { configManager: { get(key: string) {
    const url = new URL(selection.baseUrl);
    return key === 'daemon.connectedHost.enabled' || key === 'daemon.enabled' ? true : key === 'controlPlane.host' ? url.hostname : key === 'controlPlane.port' ? Number(url.port) : key === 'controlPlane.publicBaseUrl' ? selection.baseUrl : undefined;
  } } }, workspace: { get shellPaths() { return createShellPathService({ workingDirectory: selection.workspace, homeDirectory: selection.home }); } } };
}
export async function runAgentImportProof(selection: ImportProofSelection, args: string[], flags: { confirm?: boolean; explicitUserRequest?: string } = {}): Promise<string> {
  const registry = new AgentRegistry(); registerLegacyWorkLedgerImportCommands(registry);
  const result = await runCommand({ commandRegistry: registry, commandContext: context(selection, () => {}) as unknown as AgentContext, toolRegistry: new ToolRegistry() }, { commandName: 'work-import', args, ...flags });
  assert.equal(result.success, true); return result.output ?? result.error ?? '';
}
