/** Actual product entry surface, without starting unrelated full-screen services. */
import { strict as assert } from 'node:assert';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { IMPORT_FIXTURE_TOKEN } from './legacy-import-host-fixture.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { beginAgentHostPairing, completeAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { CommandRegistry as AgentRegistry, type CommandContext as AgentContext } from '../../input/command-registry.ts';
import { registerLegacyWorkLedgerImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { runCommand } from '../../tools/agent-harness-command-runner.ts';
import type { AgentHarnessToolDeps } from '../../tools/agent-harness-tool-types.ts';

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
  const deps = { commandRegistry: registry, commandContext: context(selection, () => {}) as unknown as AgentContext, toolRegistry: new ToolRegistry() };
  const input = { commandName: 'work-import', args, ...flags };
  const result = ['preview', 'status'].includes(args[0] ?? '') ? await runCommand(deps, input)
    : await runRecordedImportProof(deps, input, selection.workspace);
  assert.equal(result.success, true); return result.output ?? result.error ?? '';
}

/** The real registry issues the capability; the payload's flags issue nothing. */
export async function runRecordedImportProof(deps: AgentHarnessToolDeps, input: Record<string, unknown>, directory: string) {
  assert.equal(input.commandName, 'work-import');
  assert.ok(Array.isArray(input.args) && input.args.every(value => typeof value === 'string'));
  const original = structuredClone(input);
  const permissions = { ...DEFAULT_CONFIG.permissions, mode: 'prompt' as const };
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory }),
    getSnapshot: () => ({ permissions }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  const name = 'legacy-import-command-proof';
  const tool: Tool = { definition: { name, description: 'Execute this exact isolated legacy import command against its owned loopback host.',
    sideEffects: ['network', 'state'], parameters: { type: 'object', properties: {
      commandName: { type: 'string', enum: ['work-import'] }, args: { type: 'array', items: { type: 'string' } },
      confirm: { type: 'boolean' }, explicitUserRequest: { type: 'string' },
    }, required: ['commandName', 'args'], additionalProperties: false } },
    execute(args, options) {
      assert.deepEqual(args, original);
      return runCommand(deps, args, { signal: options?.signal, assertCurrent: () => assertCurrentToolExecution(args, options) }, options);
    } };
  registry.register(tool);
  const answers = fakePort((questionName, question, state) => {
    assert.ok(state !== null && typeof state === 'object' && !Array.isArray(state));
    if (questionName === 'disposition') {
      assert.ok(state.input !== null && typeof state.input === 'object' && !Array.isArray(state.input));
      assert.equal(state.input.tool, name); assert.deepEqual(state.input.arguments, original);
      if (question.type !== 'choice') throw new Error('Legacy import disposition must use its offered choice schema');
      return choiceAnswer(question, 'act', 0.999);
    }
    assert.equal(state.tool, name); assert.deepEqual(state.arguments, original);
    if (question.type === 'choice' && questionName === 'kind') return choiceAnswer(question, 'network', 0.999);
    if (question.type === 'choice' && questionName === 'family') return choiceAnswer(question, 'network-egress', 0.999);
    if (question.type === 'noul' && ['mutates', 'outward', 'beyondProject'].includes(questionName)) return noulAnswer(0.999);
    if (question.type === 'noul' && ['secrets', 'irreversible', 'weakensSecurity', 'catastrophic', 'cardDetails'].includes(questionName)) return noulAnswer(0.001);
    throw new Error(`Unscripted legacy import admission question: ${questionName}`);
  });
  const log = new SqliteDecisionLog(':memory:'); const previous = installJudgmentPort(withDecisionLog(answers.port, log));
  try {
    const projected = await registry.projectCall('legacy-import-proof', name, input);
    try {
      const call = await registry.prepareCall('legacy-import-proof', name, projected.args);
      const admission = await manager.admitAutonomous(call.callId, name, call.args, {
        sourceOf: () => ({ goal: 'Exercise exactly the selected legacy import command', criteria: ['Only the owned loopback fixture and temporary journal may be changed'] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      assert.equal(admission.result.autonomousDecision?.outcome, 'act');
      const result = await registry.executePrepared(call, admission);
      assert.ok(answers.requests.some(request => Object.hasOwn(request.questions, 'disposition')));
      assert.ok(!JSON.stringify(answers.requests).includes(IMPORT_FIXTURE_TOKEN));
      return result;
    } finally { await registry.releaseProjected(projected); }
  } finally { installJudgmentPort(previous); log[Symbol.dispose](); }
}
