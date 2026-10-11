import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager, DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { runDeliveryPublication } from '@goodvibes-jev/engine/sdk/platform/utils';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { channelDraftFilePath, getDraft } from '../../agent/channel-draft.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from './research-screening.ts';

/** Synthetic recorded decisions and local delivery; operator HTTP is the actual product transport. */
async function main() {
  const inputPath = process.argv[2];
  assert(inputPath);
  const input: unknown = JSON.parse(readFileSync(inputPath, 'utf8'));
  assert(input && typeof input === 'object' && 'root' in input && 'port' in input && 'seed' in input && 'token' in input);
  assert(typeof input.root === 'string' && typeof input.port === 'number' && typeof input.token === 'string');
  assert(input.seed && typeof input.seed === 'object' && 'id' in input.seed && 'message' in input.seed);
  assert(typeof input.seed.id === 'string' && typeof input.seed.message === 'string');
  const root = input.root, port = input.port, token = input.token;
  const seed = { ...input.seed, id: input.seed.id, message: input.seed.message };
  const privateId = seed.id, message = seed.message;
  resetSessionUntrustedContentLedgerForTests();
  const scripted = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    const label = name === 'disposition' ? 'act'
      : name === 'kind' ? Object.hasOwn(question.criteria, 'read') ? 'read' : 'other'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected Agent-native fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  const log = new SqliteDecisionLog(':memory:');
  const previous = installJudgmentPort(withDecisionLog(scripted.port, log));
  try {
    const paths = createShellPathService({ homeDirectory: root, workingDirectory: root });
    const path = channelDraftFilePath(paths);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, drafts: [seed] }));
    const tokenPath = connectedHostOperatorTokenPath(root);
    mkdirSync(dirname(tokenPath), { recursive: true }); writeFileSync(tokenPath, JSON.stringify({ token }), { mode: 0o600 });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root,
      configDir: join(root, '.goodvibes', 'agent') });
    configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', port);
    await configManager.flushConfigFileChanges();
    const permissionReader: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode: 'prompt' }, autoApprove: false, directory: root }),
      getSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode: 'prompt' } }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
    };
    const manager = new PermissionManager(undefined, permissionReader, new PolicyRuntimeState());
    const registry = new ToolRegistry(manager), delivery: string[] = [];
    const router = new ChannelDeliveryRouter({ strategies: [{ id: 'registered-native-peer-fixture', supportsGuardedDelivery: true, supportsPublication: true,
      canHandle: () => true, async deliver(request) {
        return runDeliveryPublication(request, current => {
          current(); assert.equal(request.body, message);
          assert.deepEqual(request.target, { kind: 'surface', surfaceKind: 'slack', routeId: 'fixture' });
          const local = getDraft(paths, privateId);
          assert(local?.daemonSyncState === 'synced');
          delivery.push(request.body); return { responseId: 'registered-native-peer-receipt' };
        });
      } }] });
    const context = { workspace: { shellPaths: paths }, platform: { config: {}, channelDeliveryRouter: router, configManager },
      session: { runtime: { sessionId: 'registered-native-peer' } }, clients: {}, extensions: { toolRegistry: registry }, ops: {} } as unknown as CommandContext;
    const screening = researchScreeningFixture();
    bindAgentResearchSourceOwner(registry, screening.owner); registerAgentHarnessTool(registry, new CommandRegistry(), context);
    const call = await registry.prepareCall('registered-native-peer-call', 'agent_harness', { mode: 'channel_draft_send', draftId: privateId });
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, {
      sourceOf: () => ({ goal: 'Deliver the exact native fixture draft.', criteria: ['Retain the original native draft and paired peer'] }),
      preparedCall: { registry, call }, schemaRevision: call.schemaRevision,
    });
    assert.equal(admission.result.autonomousDecision?.outcome, 'act');
    const result = await registry.executePrepared(call, admission);
    assert.equal(result.success, true); assert(result.output);
    const receipt = { result, localStatus: getDraft(paths, privateId)?.status, delivery,
      modelRequests: scripted.requests, screeningRequests: screening.calls,
      autonomousReadings: log.query({ site: 'engine.gate.autonomous-tool' }).length };
    assert(receipt.autonomousReadings >= 1);
    const encoded = JSON.stringify(receipt);
    const credential: unknown = JSON.parse(readFileSync(connectedHostOperatorTokenPath(root), 'utf8'));
    assert(credential && typeof credential === 'object' && 'token' in credential && typeof credential.token === 'string');
    assert(!encoded.includes(privateId)); assert(!encoded.includes(credential.token));
    process.stdout.write(encoded);
    assert.deepEqual(delivery, [message], result.output); assert.equal(getDraft(paths, privateId)?.status, 'sent', result.output);
  } finally {
    await cleanupResearchScreeningFixtures();
    installJudgmentPort(previous); log[Symbol.dispose](); resetSessionUntrustedContentLedgerForTests();
  }
}

await main();
