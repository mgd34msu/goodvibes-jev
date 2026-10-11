import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ACCOUNT_REGISTRY_PATH_SEGMENTS } from '@goodvibes-jev/engine/sdk/platform/google';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { securityPort } from '../helpers/security-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SECRET = `glpat-${'z'.repeat(20)}`; // Synthetic, never a real credential.
const SAFE = { action: 'record', serviceDomain: 'example.test', serviceUrl: 'https://example.test', aliasAddress: 'owner@example.test', purpose: 'Read product documentation', credentialSecretKey: 'EXAMPLE_PASSWORD' };
afterEach(resetSessionUntrustedContentLedgerForTests);

async function composed(body: (context: { registry: ReturnType<typeof composeAgentToolRegistry>['toolRegistry']; accountFile: string; memoryCount: () => number; runAccount: (id: string, signal?: AbortSignal) => Promise<ToolResult> }) => Promise<void>) {
  const root = makeProjectTempDir('memory-judgment-boundary');
  const workspace = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const configDir = join(homeDir, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true }); mkdirSync(configDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
  const previous = installJudgmentPort(undefined);
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir });
  const services = createRuntimeServices({ modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), configManager, workingDir: workspace, homeDirectory: homeDir, getConversationTitle: () => 'boundary-test' });
  installJudgmentPort(undefined);
  try {
    await services.memoryStore.init();
    await services.workspaceCheckpointManager.init();
    const { toolRegistry } = composeAgentToolRegistry({ services, configManager, homeDirectory: homeDir, resolveSessionId: () => 'boundary-test', getLastUserMessage: () => 'Save this memory and record this account.' });
    const runAccount = async (id: string, signal?: AbortSignal) => {
      const projected = await toolRegistry.projectCall(id, 'accounts', SAFE, { signal });
      try {
        const call = await toolRegistry.prepareCall(id, 'accounts', projected.args, { signal });
        const admission = await services.permissionManager.admitAutonomous(id, 'accounts', call.args, {
          sourceOf: () => ({ goal: 'Verify account memory boundaries with isolated synthetic sources', criteria: ['Record only the authored synthetic account in this temporary home'] }),
          signal, schemaRevision: call.schemaRevision, preparedCall: { registry: toolRegistry, call },
        });
        expect(admission.result.autonomousDecision?.outcome).toBe('act');
        return await toolRegistry.executePrepared(call, admission);
      } finally { await toolRegistry.releaseProjected(projected); }
    };
    await body({ registry: toolRegistry, runAccount, accountFile: services.shellPaths.resolveUserPath('agent', ...ACCOUNT_REGISTRY_PATH_SEGMENTS), memoryCount: () => services.memoryRegistry.getAll().length });
  } finally {
    try { await services.processManager.close(); }
    finally { services.dispose(); installJudgmentPort(previous); }
  }
}
function source(text: string, origin = 'https://untrusted.example.test') {
  getSessionUntrustedContentLedger().record({ surface: 'web-page', origin, at: new Date().toISOString(), content: text });
}

function accountReadings() {
  const security = securityPort({ derives: () => false });
  const admission = fakePort((name, question) => {
    if (question.type === 'choice') {
      const chosen = name === 'disposition' ? 'act' : name === 'kind' ? 'write' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (chosen) return choiceAnswer(question, chosen, 0.999);
    }
    if (question.type === 'noul' && ['mutates', 'outward', 'secrets', 'catastrophic', 'cardDetails', 'irreversible', 'beyondProject', 'weakensSecurity', 'refused'].includes(name)) return noulAnswer(name === 'mutates' ? 0.999 : 0.001);
    throw new Error(`Unscripted authored account admission question ${name}`);
  });
  const privacy = fakePort((name, question) => {
    if (name === 'kind' && question.type === 'choice') return choiceAnswer(question, 'other', 0.999);
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted authored account privacy question ${name}`);
  });
  const port: JudgmentPort = { model: security.port.model, ask(request) {
    const battery = request.context?.battery;
    if (battery === 'engine.security.content-derivation') return security.port.ask(request);
    if (['engine.gate.side-effect', 'engine.gate.risk-family', 'engine.gate.boundary', 'engine.gate.autonomous-disposition', 'engine.gate.autonomous-refusal'].includes(battery ?? '')) return admission.port.ask(request);
    if (['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential', 'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive'].includes(battery ?? '')) return privacy.port.ask(request);
    throw new Error(`Unscripted authored account battery ${battery}`);
  } };
  return { port, derivations: security.requests, admissionRequests: admission.requests };
}

test.each([
  { name: 'accounts', args: { ...SAFE, action: undefined, purpose: SECRET } },
  { name: 'agent_local_registry', args: { action: 'create', cls: 'fact', summary: SECRET } },
  { name: 'agent_local_registry', args: { action: 'create', cls: 'fact', summary: 'Safe summary', extra: { nested: [SECRET] } } },
])('bootstrap refuses protected malformed $name arguments before repair', async ({ name, args }) => composed(async ({ registry, accountFile, memoryCount }) => {
  const fake = securityPort({ derives: () => false }); installJudgmentPort(fake.port);
  const input: Record<string, unknown> = { ...args }; if (input.action === undefined) delete input.action;
  const pending = registry.execute('protected-malformed', name, input);
  await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
  await expect(pending).rejects.toMatchObject({ problem: 'held' });
  expect(fake.requests).toHaveLength(0);
  expect(existsSync(accountFile)).toBe(false); expect(memoryCount()).toBe(0);
}));

test('bootstrap refuses protected source text or origin before account derivation judgment', async () => composed(async ({ runAccount, accountFile }) => {
  for (const [index, [text, origin]] of [[`Unrelated page has ${SECRET}`, 'https://untrusted.example.test'], ['Unrelated public page', `https://untrusted.example.test/${SECRET}`]].entries()) {
    resetSessionUntrustedContentLedgerForTests(); source(text!, origin!);
    const fake = accountReadings(); using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
    const result = await runAccount(`protected-context-${index}`);
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.error).toContain('protected values in untrusted context');
    expect(fake.derivations).toHaveLength(0); expect(existsSync(accountFile)).toBe(false);
  }
}));

test('bootstrap admitted ordinary account reaches actual derivation and persists once', async () => composed(async ({ runAccount, accountFile }) => {
  source('An unrelated public page.');
  const fake = accountReadings(); using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  expect(await runAccount('ordinary-account')).toMatchObject({ success: true });
  expect(fake.derivations.some(request => Object.hasOwn(request.questions, 'derives'))).toBe(true);
  expect(existsSync(accountFile)).toBe(true);
}));

test('bootstrap abort during account judgment settles promptly and prevents late persistence or queued asks', async () => composed(async ({ runAccount, accountFile }) => {
  source('First unrelated public page.'); source('Second unrelated public page.', 'https://other.example.test');
  const fake = accountReadings(); using log = new SqliteDecisionLog(':memory:');
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let asks = 0;
  installJudgmentPort(withDecisionLog({ ...fake.port, async ask(request) {
    if (request.context?.battery === 'engine.security.content-derivation') { asks++; entered(); await blocked; }
    return fake.port.ask(request);
  } }, log));
  const controller = new AbortController();
  const work = runAccount('cancelled-account', controller.signal);
  await Promise.race([started, work.then(() => { throw new Error('Account derivation did not start'); })]);
  const before = asks; controller.abort(new Error(SECRET));
  const early = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
  release(); const result = await work; await new Promise((resolve) => setTimeout(resolve, 20));
  expect(early).not.toBeNull(); expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(asks).toBe(before); expect(existsSync(accountFile)).toBe(false);
}));
