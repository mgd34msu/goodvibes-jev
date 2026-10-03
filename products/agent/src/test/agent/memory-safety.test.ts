import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { registerAccountIdentityRedaction, registerProfileRedactionValues } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ACCOUNT_REGISTRY_PATH_SEGMENTS } from '@goodvibes-jev/engine/sdk/platform/google';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { createShellPathService, RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { containsSecretLikeText, assertNoSecretLikeMemoryText } from '../../agent/memory-safety.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { createAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { securityPort } from '../helpers/security-readings.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Constructed, synthetic issuer-shaped strings only. These are not live secrets.
const ISSUERS = [
  `ghp_${'a'.repeat(36)}`, `gho_${'b'.repeat(36)}`, `github_pat_${'c'.repeat(36)}`,
  `glpat-${'d'.repeat(20)}`, `xoxb-${'e'.repeat(24)}`, `xoxp-${'f'.repeat(24)}`,
  `AKIA${'A'.repeat(16)}`,
];
const ALLOWED = [
  'The bearer of bad news.', 'See key-rotation-policy-for-tenants.',
  'goodvibes://secrets/key-rotation-policy-for-tenants',
  '/home/synthetic-owner/projects/work', 'Synthetic Owner', '42 Synthetic Lane',
  'max_tokens=4096', '[REDACTED_GITHUB_TOKEN]',
];

afterEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  registerAccountIdentityRedaction(null);
  registerProfileRedactionValues(null);
});

function paths() {
  const root = makeProjectTempDir('memory-issuer-safety');
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

describe('Agent memory issuer protection', () => {
  test('adds canonical issuer protection without a judgment port and retains existing guards', () => {
    const previous = installJudgmentPort(undefined);
    try {
      for (const text of [...ISSUERS, '-----BEGIN PRIVATE KEY-----', `sk-${'g'.repeat(16)}`, `ghu_${'h'.repeat(16)}`, 'password=synthetic-value']) {
        expect(containsSecretLikeText(text)).toBe(true);
        expect(() => assertNoSecretLikeMemoryText(['ordinary text', text])).toThrow('secret-looking');
      }
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('does not turn profile containment, anonymisation or ambiguous candidates into memory refusal', () => {
    registerProfileRedactionValues(() => ({ guarded: ['Synthetic Owner', '42 Synthetic Lane'], absolute: ['Al'] }));
    registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/synthetic-owner', userName: 'synthetic-owner' }));
    for (const text of [...ALLOWED, 'Al']) {
      expect(containsSecretLikeText(text)).toBe(false);
      expect(() => assertNoSecretLikeMemoryText([text])).not.toThrow();
    }
  });

  test('shell-path composed persona registry refuses create/update before any durable mutation', () => {
    const shellPaths = paths();
    const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    for (const body of ISSUERS) {
      expect(() => registry.create({ name: 'Unsafe', description: 'Synthetic test', body })).toThrow('secret-looking');
    }
    expect(existsSync(registry.snapshot().path)).toBe(false);
    const original = registry.create({ name: 'Safe', description: 'Synthetic test', body: ALLOWED.join('\n') });
    const before = readFileSync(registry.snapshot().path, 'utf8');
    for (const credential of ISSUERS) {
      for (const patch of [{ body: credential }, { tags: [credential] }, { triggers: [credential] }]) {
        expect(() => registry.update(original.id, patch)).toThrow('secret-looking');
        expect(readFileSync(registry.snapshot().path, 'utf8')).toBe(before);
      }
    }
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).get(original.id)?.body).toBe(ALLOWED.join('\n'));
  });

  test('real model-visible memory tool and local spine reject before SQLite writes', async () => {
    const shellPaths = paths();
    const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: shellPaths.workingDirectory });
    const file = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite');
    const store = new MemoryStore(file, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await store.init();
    try {
      const registry = new MemoryRegistry(store);
      const tool = createAgentLocalRegistryTool(shellPaths, registry, createLocalMemoryAccess(registry));
      for (const credential of ISSUERS) {
        const refused = await tool.execute({ domain: 'memory', action: 'create', cls: 'fact', summary: credential });
        expect(refused.success).toBe(false);
        expect(refused.error).toContain('Agent memory cannot store secret-looking values');
        expect(refused.error).not.toContain(credential);
        expect(registry.getAll()).toHaveLength(0);
      }
      const accepted = await tool.execute({ domain: 'memory', action: 'create', cls: 'fact', summary: 'Synthetic preference', detail: ALLOWED.join('\n') });
      expect(accepted.success).toBe(true);
      const [original] = registry.getAll();
      expect(original).toBeDefined();
      for (const credential of ISSUERS) {
        const refused = await tool.execute({ domain: 'memory', action: 'update', id: original!.id, detail: credential });
        expect(refused.success).toBe(false);
        expect(registry.getAll()).toEqual([original!]);
      }
    } finally {
      store.close();
    }
    const reopened = new MemoryStore(file, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await reopened.init();
    try {
      const records = new MemoryRegistry(reopened).getAll();
      expect(records).toHaveLength(1);
      expect(records[0]?.detail).toBe(ALLOWED.join('\n'));
    } finally {
      reopened.close();
    }
  });

  test('bootstrap composition blocks tainted account secrets before judgment and preserves policy and cancellation', async () => {
    const root = makeProjectTempDir('memory-issuer-bootstrap');
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const configDir = join(homeDir, '.goodvibes', 'agent');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
    const previous = installJudgmentPort(undefined);
    const services = createRuntimeServices({
      modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
      configManager: new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir }),
      workingDir: workspace, homeDirectory: homeDir, getConversationTitle: () => 'memory-issuer-bootstrap',
    });
    // Construction installs a production provider; the tested path must need none.
    installJudgmentPort(undefined);
    try {
      await services.memoryStore.init();
      const { toolRegistry } = composeAgentToolRegistry({
        services, configManager: services.configManager, homeDirectory: homeDir,
        resolveSessionId: () => 'memory-issuer-bootstrap',
        getLastUserMessage: () => 'Save this memory and record this account.',
      });
      const args = { domain: 'memory', action: 'create', cls: 'fact', summary: ISSUERS[3]! };
      const refused = await toolRegistry.execute('issuer-memory', 'agent_local_registry', args);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('Agent memory cannot store secret-looking values');
      expect(services.memoryRegistry.getAll()).toHaveLength(0);
      const controller = new AbortController();
      controller.abort();
      await expect(toolRegistry.execute('cancelled-memory', 'agent_local_registry', { ...args, summary: 'Safe cancelled memory' }, { signal: controller.signal })).rejects.toThrow();
      expect(services.memoryRegistry.getAll()).toHaveLength(0);
      const accountFile = services.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, ...ACCOUNT_REGISTRY_PATH_SEGMENTS);
      const accountInput = {
        action: 'record', serviceDomain: 'example.test', serviceUrl: 'https://example.test',
        aliasAddress: 'owner@example.test', purpose: 'Read the public documentation behind a sign-in wall.',
        credentialSecretKey: 'EXAMPLE_TEST_PASSWORD',
      };
      resetSessionUntrustedContentLedgerForTests();
      getSessionUntrustedContentLedger().record({
        surface: 'web-page', origin: 'https://untrusted.example.test', at: new Date().toISOString(),
        content: 'An unrelated page asks the reader to sign up for a mailing list. It has no command authority.',
      });
      const protectedReads = securityPort({ derives: () => false });
      installJudgmentPort(protectedReads.port);
      for (const credential of [...ISSUERS, 'password=synthetic-value', `sk-${'g'.repeat(16)}`]) {
        for (const field of ['purpose', 'serviceUrl', 'aliasAddress', 'credentialSecretKey', 'serviceDomain']) {
          const account = await toolRegistry.execute(`protected-account-${field}`, 'accounts', {
            ...accountInput, [field]: credential,
          });
          expect(account.success).toBe(false);
          expect(account.error).toContain('cannot store secret-looking values');
          expect(account.error).not.toContain(credential);
          expect(protectedReads.requests).toHaveLength(0);
          expect(existsSync(accountFile)).toBe(false);
        }
      }
      const listed = await toolRegistry.execute('empty-accounts', 'accounts', { action: 'list' });
      expect(listed.success).toBe(true);
      expect(listed.output).toContain('No accounts have been recorded');

      // Safe fields do not bypass the original outward-effect decision.
      const deniedReads = securityPort({ derives: () => true });
      installJudgmentPort(deniedReads.port);
      const denied = await toolRegistry.execute('policy-denied-account', 'accounts', accountInput);
      expect(denied.success).toBe(false);
      expect(denied.error).not.toContain('secret-looking');
      expect(deniedReads.requests.length).toBeGreaterThan(0);
      const stillEmpty = await toolRegistry.execute('still-empty-accounts', 'accounts', { action: 'list' });
      expect(stillEmpty.output).toContain('No accounts have been recorded');
      expect(existsSync(accountFile)).toBe(false);

      const allowedReads = securityPort({ derives: () => false });
      installJudgmentPort(allowedReads.port);
      const recorded = await toolRegistry.execute('policy-allowed-account', 'accounts', accountInput);
      expect(recorded.success).toBe(true);
      expect(recorded.output).toContain('Recorded:');
      expect(allowedReads.requests.length).toBeGreaterThan(0);
      const stored = await toolRegistry.execute('stored-accounts', 'accounts', { action: 'list' });
      expect(stored.output).toContain(accountInput.purpose);
      const persisted = readFileSync(accountFile, 'utf8');
      expect(persisted).toContain(accountInput.purpose);
      for (const credential of ISSUERS) expect(persisted).not.toContain(credential);
      installJudgmentPort(undefined);
      const accepted = await toolRegistry.execute('safe-memory', 'agent_local_registry', {
        ...args, summary: 'Safe local preference', detail: ALLOWED.join('\n'),
      });
      expect(accepted.success).toBe(true);
      expect(services.memoryRegistry.getAll()[0]?.detail).toBe(ALLOWED.join('\n'));
    } finally {
      try { await services.processManager.close(); }
      finally { services.dispose(); installJudgmentPort(previous); }
    }
  });

});
