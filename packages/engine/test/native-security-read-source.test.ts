import { McpPermissionManager, captureMcpDecisionHistoryReadSource } from '../sdk/src/platform/runtime/mcp/permissions.js';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { gateReadingsPort } from './_helpers/gate-readings.ts';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from 'zustand/vanilla';
import { ApiTokenAuditor, captureTokenAuditReadSource } from '../sdk/src/platform/security/token-audit.js';
import { SecurityReadSourceRetiredError, captureSecurityReadFiles, retainSecurityReadData } from '../sdk/src/platform/security/read-source.js';
import { createRuntimeStore, captureRuntimeSecurityReadSource } from '../sdk/src/platform/runtime/store/index.js';
import { createInitialRuntimeState } from '../sdk/src/platform/runtime/store/state.js';
import { PolicyRuntimeState, capturePolicyRuntimeReadSource } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { PolicyRegistry } from '../sdk/src/platform/runtime/permissions/policy-registry.js';
import { createUnsignedBundle } from '../sdk/src/platform/runtime/permissions/policy-loader.js';
import { PermissionSimulator } from '../sdk/src/platform/runtime/permissions/simulation.js';
import { DivergenceDashboard, captureDivergenceReadSource } from '../sdk/src/platform/runtime/permissions/divergence-dashboard.js';
import { createFeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/manager.js';
import { PluginManager, capturePluginSecurityReadSource } from '../sdk/src/platform/plugins/manager.js';
import { SubscriptionManager, captureSubscriptionReadSource } from '../sdk/src/platform/config/subscriptions.js';
import { SecretsManager, captureSecretsReadSource } from '../sdk/src/platform/config/secrets.js';
import { ServiceRegistry, captureServiceReadSource } from '../sdk/src/platform/config/service-registry.js';
import { VoiceProviderRegistry, captureVoiceProviderReadSource } from '../sdk/src/platform/voice/provider-registry.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function root() {
  const path = mkdtempSync(join(tmpdir(), 'native-source-receipt-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path;
}
function tokenAuditor(now: number) {
  const auditor = new ApiTokenAuditor({ managed: false });
  auditor.registerPolicy({ id: 'fixture', name: 'Synthetic local policy', allowedScopes: ['observe'], rotationCadenceMs: 1000, rotationWarningThresholdMs: 200 });
  const token = { id: 'fixture-token', label: 'Synthetic token metadata', issuedAt: now, grantedScopes: ['observe'], policyId: 'fixture' };
  auditor.registerToken(token); return { auditor, token };
}

describe('native read receipts retain original publishers and clocks', () => {
  test('complete original hidden fields and named array metadata remain guarded', () => {
    const rows = [{ id: 'fixture' }];
    Object.defineProperty(rows, 'nativeMetadata', { value: { revision: 'original' }, enumerable: false, configurable: true });
    const current = retainSecurityReadData(rows); current();
    Object.defineProperty(rows, 'nativeMetadata', { value: { revision: 'changed' }, enumerable: false, configurable: true });
    expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('a getter in native snapshot data is refused without invocation', () => {
    let reads = 0; const source = Object.defineProperty({}, 'hidden', { get() { reads++; return 'value'; }, enumerable: false });
    expect(() => retainSecurityReadData(source)).toThrow(SecurityReadSourceRetiredError); expect(reads).toBe(0);
  });

  test('genuine runtime permission publication and restore retires the original receipt', () => {
    const store = createRuntimeStore(), original = store.getState().permissions, current = captureRuntimeSecurityReadSource(store);
    store.setState({ permissions: { ...original, revision: original.revision + 1 } }); store.setState({ permissions: original });
    expect(store.getState().permissions).toBe(original); expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('unrelated native runtime publication preserves the security receipt and unowned stores cannot mint one', () => {
    const store = createRuntimeStore(), current = captureRuntimeSecurityReadSource(store);
    store.setState({ panels: { nativePanel: true } }); expect(current).not.toThrow();
    const unowned = createStore(() => createInitialRuntimeState());
    expect(() => captureRuntimeSecurityReadSource(unowned)).toThrow(SecurityReadSourceRetiredError);
  });

  test('native token deregistration and identical re-registration retains the retirement witness', () => {
    const now = Date.now(), { auditor, token } = tokenAuditor(now), current = captureTokenAuditReadSource(auditor, now);
    expect(auditor.deregisterToken(token.id)).toBe(true); auditor.registerToken(token);
    expect(auditor.tokenCount).toBe(1); expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('token age and original audit timestamp stay intact until the exact warning threshold', () => {
    let now = 1000; const clock = spyOn(Date, 'now').mockImplementation(() => now); cleanups.push(() => clock.mockRestore());
    const { auditor } = tokenAuditor(now), original = auditor.auditAll(now), current = captureTokenAuditReadSource(auditor, now);
    now = 1799; expect(current).not.toThrow();
    expect(original.capturedAt).toBe(1000); expect(original.results[0]?.rotation.ageMs).toBe(0);
    now = 1800; expect(current).toThrow(SecurityReadSourceRetiredError);
    expect(auditor.auditAll(now).rotationWarnings).toEqual(['fixture-token']);
  });

  test('overdue uses the actual strict deadline and backward clock movement retires a read', () => {
    let now = 2000; const clock = spyOn(Date, 'now').mockImplementation(() => now); cleanups.push(() => clock.mockRestore());
    const { auditor } = tokenAuditor(1000), atDeadline = captureTokenAuditReadSource(auditor, now);
    expect(auditor.auditAll(now).rotationOverdue).toEqual([]); now = 2001;
    expect(atDeadline).toThrow(SecurityReadSourceRetiredError); expect(auditor.auditAll(now).rotationOverdue).toEqual(['fixture-token']);
    const afterDeadline = captureTokenAuditReadSource(auditor, now); now = 2000;
    expect(afterDeadline).toThrow(SecurityReadSourceRetiredError);
  });

  test('actual native flag change and restore cannot preserve a token read receipt', () => {
    const flags = createFeatureFlagManager(), auditor = new ApiTokenAuditor({ managed: true, featureFlags: flags });
    const current = captureTokenAuditReadSource(auditor), original = flags.getState('token-scope-rotation-audit');
    flags.kill('token-scope-rotation-audit', 'Synthetic source retirement control'); flags.disable('token-scope-rotation-audit');
    if (original === 'enabled') flags.enable('token-scope-rotation-audit');
    expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('a caller-authored flag reader cannot supply a native receipt', () => {
    const auditor = new ApiTokenAuditor({ managed: true, featureFlags: { isEnabled: () => true } });
    expect(() => captureTokenAuditReadSource(auditor)).toThrow(SecurityReadSourceRetiredError);
  });

  test('policy guards retain the actual timestamped snapshot without regenerating it, then retire on native publication', () => {
    const state = new PolicyRuntimeState(), native = state.getSnapshot.bind(state), read = spyOn(state, 'getSnapshot').mockImplementation(native);
    cleanups.push(() => read.mockRestore()); const source = capturePolicyRuntimeReadSource(state), timestamp = source.snapshot.capturedAt;
    source.assertCurrent(); source.assertCurrent(); expect(read).toHaveBeenCalledTimes(1); expect(source.snapshot.capturedAt).toBe(timestamp);
    state.recordPermissionRequest({ callId: 'native-read', tool: 'read', category: 'read',
      analysis: { classification: 'read', riskLevel: 'low', summary: 'Synthetic local observation', reasons: ['Exact source control'] } });
    expect(source.assertCurrent).toThrow(SecurityReadSourceRetiredError);
  });

  test('a genuine policy candidate publication retires the original policy source before simulation', () => {
    const registry = new PolicyRegistry(), state = new PolicyRuntimeState(registry), source = capturePolicyRuntimeReadSource(state);
    const result = registry.loadCandidate(createUnsignedBundle('fixture-policy', { version: 1, rules: [], description: 'Synthetic policy' }));
    expect(result.ok).toBe(true); expect(source.assertCurrent).toThrow(SecurityReadSourceRetiredError);
  });

  test('real simulator evaluations and dashboard mode restore retire captured divergence data', () => {
    const rules = [{ id: 'fixture-read', type: 'prefix' as const, origin: 'managed' as const, effect: 'allow' as const, toolPattern: 'read' }];
    const simulator = new PermissionSimulator({ mode: 'default', rules }, { mode: 'default', rules }, 'simulation-only');
    const dashboard = new DivergenceDashboard(simulator, 'simulation-only'), original = captureDivergenceReadSource(dashboard);
    simulator.evaluate('read', { path: '/synthetic/source' }, 'read'); expect(original).toThrow(SecurityReadSourceRetiredError);
    const next = captureDivergenceReadSource(dashboard); dashboard.setMode('warn-on-divergence'); dashboard.setMode('simulation-only');
    expect(next).toThrow(SecurityReadSourceRetiredError);
  });

  test('a native plugin manifest replacement with identical bytes retires its original inode', () => {
    const path = root(), pluginRoot = join(path, '.goodvibes', 'plugins', 'fixture'); mkdirSync(pluginRoot, { recursive: true });
    const manifest = join(pluginRoot, 'manifest.json'); writeFileSync(manifest, JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'Synthetic manifest' }));
    const manager = new PluginManager({ pathOptions: { cwd: path, homeDir: path }, stateFilePath: join(path, 'plugins-state.json') });
    const current = capturePluginSecurityReadSource(manager); current();
    const replacement = join(pluginRoot, 'replacement.json'); writeFileSync(replacement, readFileSync(manifest)); renameSync(replacement, manifest);
    expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('native subscription and service capture receipts retain their actual file images', () => {
    const path = root(), home = join(path, 'home'), project = join(path, 'project'); mkdirSync(home); mkdirSync(project);
    const subscriptionsFile = join(path, 'subscriptions.json'); writeFileSync(subscriptionsFile, JSON.stringify({ version: 1, subscriptions: {}, pending: {} }));
    const subscriptions = new SubscriptionManager(subscriptionsFile), secretManager = new SecretsManager({ globalHome: home, projectRoot: project, surfaceRoot: 'fixture', policy: 'require_secure' });
    const servicesFile = join(path, 'services.json'); writeFileSync(servicesFile, '{}');
    const services = new ServiceRegistry(servicesFile, { secretsManager: secretManager, subscriptionManager: subscriptions, diagnosticMode: 'structural' });
    const subscriptionCurrent = captureSubscriptionReadSource(subscriptions), serviceCurrent = captureServiceReadSource(services), secretCurrent = captureSecretsReadSource(secretManager);
    expect(subscriptionCurrent).not.toThrow(); expect(serviceCurrent).not.toThrow(); expect(secretCurrent).not.toThrow();
    const replacement = join(path, 'subscriptions-next.json'); writeFileSync(replacement, readFileSync(subscriptionsFile)); renameSync(replacement, subscriptionsFile);
    expect(subscriptionCurrent).toThrow(SecurityReadSourceRetiredError); expect(serviceCurrent).toThrow(SecurityReadSourceRetiredError);
  });

  test('native absent-store credential continuation refuses replacement before any forged local read', async () => {
    const path = root(), home = join(path, 'home'), project = join(path, 'project'); mkdirSync(home); mkdirSync(project);
    const subscriptions = new SubscriptionManager(join(path, 'subscriptions.json'));
    const secrets = new SecretsManager({ globalHome: home, projectRoot: project, surfaceRoot: 'fixture', policy: 'require_secure' });
    const servicesFile = join(path, 'services.json'), key = 'NATIVE_SOURCE_FIXTURE_KEY';
    const previous = process.env[key]; delete process.env[key];
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    writeFileSync(servicesFile, JSON.stringify({ fixture: { name: 'fixture', authType: 'bearer', tokenKey: key } }));
    const services = new ServiceRegistry(servicesFile, { secretsManager: secrets, subscriptionManager: subscriptions, diagnosticMode: 'structural' });
    expect(await services.inspect('fixture')).toMatchObject({ hasPrimaryCredential: false });
    const original = captureServiceReadSource(services), operation = services.inspect('fixture'); let forgedReads = 0;
    Object.defineProperty(secrets, 'getInternal', { configurable: true, value: async () => {
      forgedReads++; Reflect.deleteProperty(secrets, 'getInternal'); return 'synthetic-nonempty-observation';
    } });
    try {
      await expect(operation).rejects.toThrow(SecurityReadSourceRetiredError);
      expect(forgedReads).toBe(0);
    } finally { Reflect.deleteProperty(secrets, 'getInternal'); }
    expect(original).not.toThrow(); expect(await services.inspect('fixture')).toMatchObject({ hasPrimaryCredential: false });
  });

  test('native inspect and detailed-list continuations refuse replaced original local collectors', async () => {
    for (const method of ['listDetailed', 'readEncryptedFile']) {
      const path = root(), home = join(path, 'home'), project = join(path, 'project'); mkdirSync(home); mkdirSync(project);
      const secrets = new SecretsManager({ globalHome: home, projectRoot: project, surfaceRoot: 'fixture', policy: 'require_secure' });
      const operation = method === 'listDetailed' ? secrets.inspect() : secrets.listDetailed(); let forgedReads = 0;
      Object.defineProperty(secrets, method, { configurable: true, value: () => {
        forgedReads++; Reflect.deleteProperty(secrets, method); return [];
      } });
      try { await expect(operation).rejects.toThrow(SecurityReadSourceRetiredError); expect(forgedReads).toBe(0); }
      finally { Reflect.deleteProperty(secrets, method); }
    }
  });

  test('native service inspection drains every started local resolver before publishing retirement', async () => {
    const path = root(), home = join(path, 'home'), project = join(path, 'project'); mkdirSync(home); mkdirSync(project);
    const secrets = new SecretsManager({ globalHome: home, projectRoot: project, surfaceRoot: 'fixture', policy: 'require_secure' });
    const subscriptions = new SubscriptionManager(join(path, 'subscriptions.json')), servicesFile = join(path, 'services.json');
    const primaryKey = 'NATIVE_DRAIN_PRIMARY_KEY', passwordKey = 'NATIVE_DRAIN_PASSWORD_KEY';
    for (const key of [primaryKey, passwordKey]) {
      const previous = process.env[key]; delete process.env[key];
      cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    writeFileSync(servicesFile, JSON.stringify({ fixture: { name: 'fixture', authType: 'basic', tokenKey: primaryKey, passwordKey } }));
    let releasePrimary: (() => void) | undefined, releasePassword: (() => void) | undefined, enteredPassword: (() => void) | undefined;
    const primaryWait = new Promise<void>(resolve => { releasePrimary = resolve; });
    const passwordWait = new Promise<void>(resolve => { releasePassword = resolve; });
    const passwordEntered = new Promise<void>(resolve => { enteredPassword = resolve; });
    const originalRead = secrets.get;
    // Both instrumented continuations forward the genuine original native local read.
    secrets.get = async (key) => {
      const value = await originalRead.call(secrets, key);
      if (key === primaryKey) await primaryWait;
      if (key === passwordKey) { enteredPassword?.(); await passwordWait; }
      return value;
    };
    const services = new ServiceRegistry(servicesFile, { secretsManager: secrets, subscriptionManager: subscriptions, diagnosticMode: 'structural' });
    const operation = services.inspect('fixture'); let settled = false;
    const observation = operation.then(() => { settled = true; }, () => { settled = true; });
    try {
      await passwordEntered;
      secrets.get = originalRead;
      if (!releasePrimary || !releasePassword) throw new Error('Original native resolver controls missing');
      releasePrimary();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      releasePassword();
      await expect(operation).rejects.toThrow(SecurityReadSourceRetiredError);
      await observation; expect(settled).toBe(true);
    } finally {
      secrets.get = originalRead; releasePrimary?.(); releasePassword?.(); await observation;
    }
  });

  test('native MCP history source bypasses replaced instance issuers and refuses copied owners', async () => {
    const manager = new McpPermissionManager(); let issuers = 0;
    manager.captureSecurityDecisionReadSource = () => { issuers++; return () => {}; };
    const current = captureMcpDecisionHistoryReadSource(manager); current(); expect(issuers).toBe(0);
    const copied: object = Object.assign(Object.create(Object.getPrototypeOf(manager)), manager);
    expect(() => Reflect.apply(captureMcpDecisionHistoryReadSource, undefined, [copied])).toThrow(SecurityReadSourceRetiredError);
    manager.registerServer('fixture');
    expect(manager.isToolAllowed('fixture', 'list').allowed).toBe(true);
    expect(manager.listRecentDecisions()).toEqual([]); expect(current).not.toThrow();
    const { port } = gateReadingsPort([['', { capability: 'metadata', family: 'generic', mutates: false, kind: 'read' }]]);
    const beforeEvaluation = Date.now();
    const permission = await manager.evaluateToolCall('fixture', 'list', {}, { port });
    expect(permission).toMatchObject({ allowed: true, verdict: 'allow', capability: 'metadata', riskLevel: 'low' });
    const decisions = manager.listRecentDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ serverName: 'fixture', toolName: 'list', verdict: 'allow', capability: 'metadata', riskLevel: 'low', incoherent: false, profileMode: 'ask-on-risk' });
    const evaluatedAt = decisions[0]?.evaluatedAt;
    if (typeof evaluatedAt !== 'number') throw new Error('Actual native decision timestamp missing');
    expect(evaluatedAt).toBeGreaterThanOrEqual(beforeEvaluation); expect(evaluatedAt).toBeLessThanOrEqual(Date.now());
    expect(current).toThrow(SecurityReadSourceRetiredError); expect(issuers).toBe(0);
  });

  test('native file capture retains absence across create and remove', () => {
    const path = join(root(), 'native-marker.json'), current = captureSecurityReadFiles([path]); current();
    writeFileSync(path, '{}'); rmSync(path); expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('actual provider registration restore retires the native registry receipt', () => {
    const registry = new VoiceProviderRegistry(), provider = { id: 'fixture', label: 'Fixture', capabilities: ['voice-list'] as const };
    registry.register(provider); const current = captureVoiceProviderReadSource(registry); current();
    registry.unregister(provider.id); registry.register(provider); expect(registry.list()).toEqual([provider]);
    expect(current).toThrow(SecurityReadSourceRetiredError);
  });

  test('a native registry revision accessor is refused before it can run', () => {
    const registry = new VoiceProviderRegistry(); let reads = 0;
    Object.defineProperty(registry, 'incarnation', { get() { reads++; return 0; }, configurable: true });
    expect(() => captureVoiceProviderReadSource(registry)).toThrow(SecurityReadSourceRetiredError);
    expect(reads).toBe(0);
  });

  test('replacement WeakMap lookup cannot issue a genuine receipt for a copied native registry', () => {
    const registry = new VoiceProviderRegistry(), current = captureVoiceProviderReadSource(registry);
    const copied: object = Object.assign(Object.create(Object.getPrototypeOf(registry)), registry);
    const replacement = spyOn(WeakMap.prototype, 'get').mockReturnValue(() => current);
    try {
      expect(() => Reflect.apply(captureVoiceProviderReadSource, undefined, [copied])).toThrow(SecurityReadSourceRetiredError);
      expect(current).not.toThrow();
    } finally { replacement.mockRestore(); }
  });
});
