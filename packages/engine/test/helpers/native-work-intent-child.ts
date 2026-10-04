/** Owned test child: commits an unassociated native intent, then exits without graceful cleanup. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../../sdk/src/platform/knowledge/store.js';
import { PairingTokenManager } from '../../sdk/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../../sdk/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { createNativeWorkExecutionHost } from '../../sdk/src/platform/workflow/work-ledger/native-execution.js';
import type { NativeWorkExecutionTarget } from '../../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import { makeHarness } from '../contract/runner-support.js';
const root = process.argv[2]; if (!root) throw new Error('Owned fixture root required');
const input = JSON.parse(readFileSync(join(root, '.goodvibes', 'native-child-fixture.json'), 'utf8')) as { token: string; target: NativeWorkExecutionTarget; marker: string };
if (input.marker !== 'owned-native-intent-child') throw new Error('Not a native test fixture');
const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json'));
const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => null, gatewayMethods: new GatewayMethodCatalog(),
  userAuth: { validateSession: () => null, getUser: () => null } } as unknown as DaemonControlPlaneContext);
const authority = helper.createNativeExecutionAuthority(input.token); if (!authority) throw new Error('Fixture paired authority unavailable');
const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
const storage = await store.openNativeWorkExecutionStorage('project');
const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
const port = withDecisionLog({ ...fake.port, async ask() {
  const current = storage.currentByAttempt(input.target.attemptId);
  if (!current.intent || current.intent.state !== 'admitting' || current.record) throw new Error('Fixture must exit before native association');
  process.stdout.write(JSON.stringify({ generation: current.intent.generation, state: current.intent.state }));
  process.exit(0);
} }, log);
const host = createNativeWorkExecutionHost({ projectId: 'project', projectRoot: root, sessionId: 'native-fixture', storage, scopes, port, decisionLog: log });
const harness = makeHarness({ root, scripts: {}, decisionLog: log, contract: { maxActiveContracts: 0 }, nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission });
host.attachRunner(harness.runner);
await host.start(input.target, authority);
throw new Error('Owned pending-intent child should exit during its first Jev read');
