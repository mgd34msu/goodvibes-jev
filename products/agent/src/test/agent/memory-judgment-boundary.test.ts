import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ACCOUNT_REGISTRY_PATH_SEGMENTS } from '@goodvibes-jev/engine/sdk/platform/google';
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

async function composed(body: (context: { registry: ReturnType<typeof composeAgentToolRegistry>['toolRegistry']; accountFile: string; memoryCount: () => number }) => Promise<void>) {
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
    const { toolRegistry } = composeAgentToolRegistry({ services, configManager, homeDirectory: homeDir, resolveSessionId: () => 'boundary-test', getLastUserMessage: () => 'Save this memory and record this account.' });
    await body({ registry: toolRegistry, accountFile: services.shellPaths.resolveUserPath('agent', ...ACCOUNT_REGISTRY_PATH_SEGMENTS), memoryCount: () => services.memoryRegistry.getAll().length });
  } finally {
    try { await services.processManager.close(); }
    finally { services.dispose(); installJudgmentPort(previous); }
  }
}
function source(text: string, origin = 'https://untrusted.example.test') {
  getSessionUntrustedContentLedger().record({ surface: 'web-page', origin, at: new Date().toISOString(), content: text });
}

test.each([
  { name: 'accounts', args: { ...SAFE, action: undefined, purpose: SECRET } },
  { name: 'agent_local_registry', args: { action: 'create', cls: 'fact', summary: SECRET } },
  { name: 'agent_local_registry', args: { action: 'create', cls: 'fact', summary: 'Safe summary', extra: { nested: [SECRET] } } },
])('bootstrap refuses protected malformed $name arguments before repair', async ({ name, args }) => composed(async ({ registry, accountFile, memoryCount }) => {
  const fake = securityPort({ derives: () => false }); installJudgmentPort(fake.port);
  const input: Record<string, unknown> = { ...args }; if (input.action === undefined) delete input.action;
  const result = await registry.execute('protected-malformed', name, input).catch(() => ({ success: false }));
  expect(result.success).toBe(false); expect(fake.requests).toHaveLength(0);
  expect(existsSync(accountFile)).toBe(false); expect(memoryCount()).toBe(0);
}));

test('bootstrap refuses protected source text or origin before account derivation judgment', async () => composed(async ({ registry, accountFile }) => {
  for (const [text, origin] of [[`Unrelated page has ${SECRET}`, 'https://untrusted.example.test'], ['Unrelated public page', `https://untrusted.example.test/${SECRET}`]]) {
    resetSessionUntrustedContentLedgerForTests(); source(text!, origin!);
    const fake = securityPort({ derives: () => false }); installJudgmentPort(fake.port);
    const result = await registry.execute('protected-context', 'accounts', SAFE);
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(0); expect(existsSync(accountFile)).toBe(false);
  }
}));

test('bootstrap abort during account judgment settles promptly and prevents late persistence or queued asks', async () => composed(async ({ registry, accountFile }) => {
  source('First unrelated public page.'); source('Second unrelated public page.', 'https://other.example.test');
  const fake = securityPort({ derives: () => false });
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let asks = 0;
  installJudgmentPort({ ...fake.port, async ask(request) { asks++; entered(); await blocked; return fake.port.ask(request); } });
  const controller = new AbortController();
  const work = registry.execute('cancelled-account', 'accounts', SAFE, { signal: controller.signal }).catch(() => ({ success: false }));
  await started; const before = asks; controller.abort(new Error(SECRET));
  const early = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
  release(); const result = await work; await new Promise((resolve) => setTimeout(resolve, 20));
  expect(early).not.toBeNull(); expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(asks).toBe(before); expect(existsSync(accountFile)).toBe(false);
}));
