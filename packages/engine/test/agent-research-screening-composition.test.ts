import { screeningAnswers } from './_helpers/screening-answers.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directClient from '../sdk/src/platform/security/source-screening/direct-client.ts';
import * as screeningTransport from '../sdk/src/platform/security/source-screening/transport.ts';
import { createProtectedSourceOwner, type ProtectedSourceOwner } from '../sdk/src/platform/security/index.js';
import { HOSTED_SOURCE_SCREENING_ROUTES as routes } from '../sdk/src/platform/security/source-screening/transport.ts';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { AgentConfigManager, AGENT_HOSTED_RESEARCH_SCREENING_KEY as KEY } from '../../../products/agent/src/config/host-settings.ts';
import { SecretsManager } from '../../../products/agent/src/config/secrets.ts';
import { createAgentResearchSourceOwner } from '../../../products/agent/src/runtime/research-source-screening.ts';
import { agentResearchSourceOwner, agentResearchReportSourceOwner, createAgentResearchReportProjector,
  prepareProtectedResearchReport } from '../../../products/agent/src/agent/protected-research-report.ts';
import { createAgentResearchReportTool, registerAgentResearchReportTool } from '../../../products/agent/src/tools/agent-research-report-tool.ts';
import { effectAdmissionFixture } from '../../../products/agent/src/test/helpers/effect-admission.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Research acquisition fixture did not close');
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed synthetic protocol');
  return Object.fromEntries(Object.entries(value));
}
function environment(key: string, value: string | undefined): void {
  const original = process.env[key];
  cleanup.push(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function fixture(respond?: (request: Request, number: number) => Promise<Response> | Response) {
  const root = mkdtempSync(join(tmpdir(), 'agent-research-native-grant-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project'), globalHome = join(root, 'home');
  mkdirSync(projectRoot); mkdirSync(globalHome);
  const config = new AgentConfigManager({ configDir: join(root, 'config'), workingDir: projectRoot, surfaceRoot: 'agent' });
  const secrets = new SecretsManager({ projectRoot, globalHome, policy: 'plaintext_allowed' });
  environment('ABACUSAI_API_KEY', 'synthetic-research-abacus');
  environment('TYPESAFE_API_KEY', 'synthetic-research-typesafe');
  const calls: string[] = [];
  const stub = spyOn(directClient, 'fetchDirect').mockImplementation(async (_client, request) => {
    calls.push(request.url);
    if (respond) return respond(request, calls.length);
    if (request.url === routes.proposal) {
      const body = object(JSON.parse(await request.text()));
      const messages = body.messages;
      if (!Array.isArray(messages)) throw new Error('Missing synthetic messages');
      const content = object(messages[1]).content;
      if (typeof content !== 'string') throw new Error('Missing synthetic source');
      const source = object(JSON.parse(content));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: screeningAnswers(JSON.parse(await request.text()), { complete: 1, precise: 1 }),
      usage: { input_tokens: 10, output_tokens: 2 } });
  });
  cleanup.push(() => stub.mockRestore());
  const lifetime = new AbortController();
  const owner = createAgentResearchSourceOwner(config, secrets, lifetime.signal);
  cleanup.push(() => owner.close());
  return { root, projectRoot, config, secrets, owner, lifetime, calls };
}
async function settled(f: ReturnType<typeof fixture>, text = 'Synthetic research source.') {
  const source = f.owner.capture([text]);
  const result = await f.owner.screen(source);
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Synthetic screening did not settle');
  expect(f.owner.project(result.receipt)).toEqual([text]);
  return { source, receipt: result.receipt };
}
const report = { title: 'Native research report', question: 'What is supported?', summary: 'Reviewed evidence [S1].',
  sources: [{ title: 'Reviewed source', url: 'https://example.test/article', note: 'Synthetic reviewed evidence.' }] };

test('research screening defaults held without startup persistence or unrelated inbox consent', async () => {
  const f = fixture();
  expect(f.config.getHostBooleanSetting(KEY).get()).toBe(false);
  expect(f.config.getHostSettingsSchema().find(setting => setting.key === KEY)).toMatchObject({ type: 'boolean', default: false });
  const description = f.config.getHostSettingsSchema().find(setting => setting.key === KEY)?.description;
  expect(description).toContain('raw research report');
  expect(description).toContain('Providers manage retention; zero retention is unverified');
  expect(() => f.owner.capture(['Synthetic private report'])).toThrow();
  expect(() => readFileSync(f.config.getConfigPath())).toThrow();
  f.config.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
  expect(() => f.owner.capture(['Synthetic private report'])).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('genuine native report grant and credentials qualify registered preview and native artifact save', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  expect(new AgentConfigManager({ configDir: join(f.root, 'config'), workingDir: f.projectRoot, surfaceRoot: 'agent' }).getHostBooleanSetting(KEY).get()).toBe(true);
  const store = new ArtifactStore({ rootDir: join(f.root, 'artifacts') });
  const admission = effectAdmissionFixture();
  registerAgentResearchReportTool(admission.registry, store, f.owner, 'report-only');
  const raw = createAgentResearchReportTool(store, f.owner);
  expect(agentResearchReportSourceOwner(admission.registry)).toBe(f.owner);
  expect(agentResearchSourceOwner(admission.registry)).toBeUndefined();
  const preview = await admission.run(raw, { ...report, preview: true });
  expect(preview.success, preview.error).toBe(true); expect(store.list()).toHaveLength(0);
  const saved = await admission.run(raw, report);
  expect(saved.success, saved.error).toBe(true); expect(store.list()).toHaveLength(1);
  const artifact = store.list()[0];
  if (!artifact) throw new Error('Native artifact is missing');
  const record = store.getRecord(artifact.id);
  if (!record) throw new Error('Native artifact metadata is missing');
  expect(readFileSync(record.contentPath, 'utf8')).toContain('Reviewed evidence [S1].');
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(url => url === routes.proposal || url === routes.judgment)).toBe(true);
});

test('unregistered config or missing credential cannot mint a hosted research owner', () => {
  const f = fixture();
  const bare = new ConfigManager({ configDir: join(f.root, 'bare') });
  const owner = createAgentResearchSourceOwner(bare, f.secrets, f.lifetime.signal); cleanup.push(() => owner.close());
  expect(() => owner.capture(['Unconfigured synthetic report'])).toThrow();
  f.config.getHostBooleanSetting(KEY).set(true); delete process.env.TYPESAFE_API_KEY;
  expect(() => f.owner.capture(['Missing credential report'])).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('original receipt retires on native consent ABA while fresh report uses a fresh grant', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const original = await settled(f);
  f.config.getHostBooleanSetting(KEY).set(false); f.config.getHostBooleanSetting(KEY).set(true);
  expect(() => f.owner.project(original.receipt)).toThrow();
  await settled(f, 'Fresh synthetic report.');
  expect(() => f.owner.project(original.receipt)).toThrow();
  await f.owner.release(original.source);
});

test('native durable config drift and restored bytes retire an original source before provider work', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const source = f.owner.capture(['Captured synthetic report']);
  const path = f.config.getConfigPath(), bytes = readFileSync(path);
  writeFileSync(path, '{}'); writeFileSync(path, bytes);
  expect(await f.owner.screen(source)).toMatchObject({ status: 'held' });
  expect(f.calls).toHaveLength(0);
});

test('native local credential aliases retain physical source and refuse replacement', async () => {
  const f = fixture();
  await f.secrets.set('RESEARCH_ABACUS', 'synthetic-local-abacus', { medium: 'plaintext', scope: 'user' });
  process.env.ABACUSAI_API_KEY = 'goodvibes://secrets/RESEARCH_ABACUS';
  f.config.getHostBooleanSetting(KEY).set(true);
  const original = await settled(f);
  await f.secrets.set('RESEARCH_ABACUS', 'synthetic-local-replacement', { medium: 'plaintext', scope: 'user' });
  expect(() => f.owner.project(original.receipt)).toThrow();
  await settled(f, 'New synthetic report with current native alias.');
});

test('revocation during an awaited provider response holds original complete source and prevents judgment', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async request => {
    const body = object(JSON.parse(await request.text())), messages = body.messages;
    if (!Array.isArray(messages)) throw new Error('Missing synthetic messages');
    const content = object(messages[1]).content;
    if (typeof content !== 'string') throw new Error('Missing synthetic source');
    const source = object(JSON.parse(content));
    expect(source.parts).toEqual(['Full original synthetic private report']);
    entered.resolve(); await release.promise;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
  });
  cleanup.push(() => release.resolve());
  f.config.getHostBooleanSetting(KEY).set(true);
  const handle = f.owner.capture(['Full original synthetic private report']), pending = f.owner.screen(handle);
  try { await entered.promise; f.config.getHostBooleanSetting(KEY).set(false); }
  finally { release.resolve(); }
  expect(await pending).toMatchObject({ status: 'held' }); expect(f.calls).toEqual([routes.proposal]);
});

test('report caller cancellation releases original sources and closes pending provider work before artifact save', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async request => {
    entered.resolve(); await release.promise;
    const body = object(JSON.parse(await request.text())), messages = body.messages;
    if (!Array.isArray(messages)) throw new Error('Missing synthetic messages');
    const content = object(messages[1]).content;
    if (typeof content !== 'string') throw new Error('Missing synthetic source');
    const source = object(JSON.parse(content));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
  });
  cleanup.push(() => release.resolve());
  f.config.getHostBooleanSetting(KEY).set(true);
  const caller = new AbortController();
  const pending = prepareProtectedResearchReport(f.owner, report, { signal: caller.signal });
  try { await entered.promise; caller.abort(); } finally { release.resolve(); }
  await expect(pending).rejects.toThrow(); expect(f.calls).toEqual([routes.proposal]);
});

test('grant never bypasses recorded plan admission for a native report artifact write', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const store = new ArtifactStore({ rootDir: join(f.root, 'artifacts') });
  const admission = effectAdmissionFixture('plan');
  const raw = createAgentResearchReportTool(store, f.owner);
  const tool = admission.tool(raw, { inputProjection: createAgentResearchReportProjector(f.owner) });
  const result = await tool.execute(report);
  expect(result.success).toBe(false); expect(store.list()).toHaveLength(0);
});

test('host cancellation and native method replacement cannot be adopted as a new acquisition', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const original = await settled(f);
  f.lifetime.abort(); expect(() => f.owner.project(original.receipt)).toThrow();
  expect(() => f.owner.capture(['Late new report'])).toThrow();
  const g = fixture(); g.config.getHostBooleanSetting(KEY).set(true);
  Object.defineProperty(g.config, 'getHostBooleanSetting', { value: () => { throw new Error('Borrowed callback must not run'); } });
  expect(() => g.owner.capture(['Borrowed report'])).toThrow(); expect(g.calls).toHaveLength(0);
});


test.each(['consent', 'config-current', 'credential-read', 'credential-current'])(
  'replacement %s accessor returning the original method never runs or preserves a grant', async role => {
    const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
    const original = await settled(f);
    let getters = 0;
    const replace = (owner: object, key: string, method: unknown): void => {
      Object.defineProperty(owner, key, { configurable: true, get() { getters++; return method; } });
    };
    if (role === 'consent') replace(f.config, 'getHostBooleanSetting', f.config.getHostBooleanSetting);
    else if (role === 'config-current') replace(f.config, 'getConfigurationIncarnation', f.config.getConfigurationIncarnation);
    else if (role === 'credential-read') replace(f.secrets, 'resolveLocalCredentialSnapshot', f.secrets.resolveLocalCredentialSnapshot);
    else replace(f.secrets, 'getCredentialMutationState', f.secrets.getCredentialMutationState);
    const before = f.calls.length;
    expect(() => f.owner.capture(['Late synthetic report'])).toThrow();
    expect(() => f.owner.project(original.receipt)).toThrow();
    expect(await f.owner.screen(original.source)).toMatchObject({ status: 'held' });
    expect(getters).toBe(0); expect(f.calls).toHaveLength(before);
  },
);

test('accessor-backed initial host method is refused without invoking the accessor', () => {
  const f = fixture();
  let getters = 0;
  const original = f.config.getHostBooleanSetting;
  Object.defineProperty(f.config, 'getHostBooleanSetting', { configurable: true, get() { getters++; return original; } });
  expect(() => createAgentResearchSourceOwner(f.config, f.secrets, f.lifetime.signal)).toThrow();
  expect(getters).toBe(0); expect(f.calls).toHaveLength(0);
});

test('a replacement native consent dependency cannot supply consent through an accessor', () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  let getters = 0;
  const original = f.config.get;
  Object.defineProperty(f.config, 'get', { configurable: true, get() { getters++; return original; } });
  expect(() => f.owner.capture(['Synthetic report after native dependency replacement'])).toThrow();
  expect(getters).toBe(0); expect(f.calls).toHaveLength(0);
});

test('close retires capture and references before reentrant abort and drains the exact provider work', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let captureAttempts = 0, referenceAttempts = 0, captured = false, referenceCaptured = false;
  let reentered: Promise<void> | undefined;
  let currentOwner: ProtectedSourceOwner | undefined;
  const f = fixture(async request => {
    const body = object(JSON.parse(await request.text())), messages = body.messages;
    if (!Array.isArray(messages)) throw new Error('Missing synthetic messages');
    const content = object(messages[1]).content;
    if (typeof content !== 'string') throw new Error('Missing synthetic source');
    const source = object(JSON.parse(content));
    const owner = currentOwner;
    if (!owner) throw new Error('Synthetic acquisition owner is missing');
    request.signal.addEventListener('abort', () => {
      captureAttempts++;
      try { owner.capture(['Reentrant synthetic report']); captured = true; } catch { /* Required refusal. */ }
      referenceAttempts++;
      try { owner.captureResearchReference('https://example.test/reentrant'); referenceCaptured = true; } catch { /* Required refusal. */ }
      reentered = owner.close();
    }, { once: true });
    entered.resolve(); await release.promise;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
  });
  cleanup.push(() => release.resolve());
  currentOwner = f.owner;
  f.config.getHostBooleanSetting(KEY).set(true);
  const handle = f.owner.capture(['Pending synthetic report']), pending = f.owner.screen(handle);
  let closing: Promise<void> | undefined, finished = false;
  try {
    await entered.promise;
    closing = f.owner.close();
    void closing.then(() => { finished = true; }, () => { finished = true; });
    expect(captureAttempts).toBe(1); expect(referenceAttempts).toBe(1);
    expect(captured).toBe(false); expect(referenceCaptured).toBe(false);
    expect(reentered).toBe(closing); expect(f.owner.close()).toBe(closing);
    await Promise.resolve(); expect(finished).toBe(false);
    expect(() => f.owner.capture(['Post-close synthetic report'])).toThrow();
  } finally {
    release.resolve(); await Promise.all([pending, ...(closing ? [closing] : [])]);
  }
  expect(await pending).toMatchObject({ status: 'held' });
  expect(finished).toBe(true); expect(f.calls).toEqual([routes.proposal]);
});

test('real registration preserves broad and report owners independently when the broad owner retires', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const broadLifetime = new AbortController();
  const broad = createProtectedSourceOwner(Object.freeze({ kind: 'hosted',
    authority: Object.freeze({ kind: 'hosted', ownerId: 'synthetic-broad-owner', revision: 'synthetic-broad-revision',
      retention: 'provider-managed-zero-retention-unverified', signal: broadLifetime.signal, assertCurrent: () => broadLifetime.signal.throwIfAborted() }),
    credentials: Object.freeze({ abacusApiKey: 'synthetic-broad-abacus', typesafeApiKey: 'synthetic-broad-typesafe' }),
  }));
  cleanup.push(() => broad.close());
  const admission = effectAdmissionFixture();
  const store = new ArtifactStore({ rootDir: join(f.root, 'dual-owner-artifacts') });
  registerAgentResearchReportTool(admission.registry, store, f.owner, 'report-only', broad);
  expect(agentResearchSourceOwner(admission.registry)).toBe(broad);
  expect(agentResearchReportSourceOwner(admission.registry)).toBe(f.owner);
  const broadSource = broad.capture(['Synthetic broad private source']);
  const broadReading = await broad.screen(broadSource);
  expect(broadReading.status).toBe('settled');
  if (broadReading.status !== 'settled') throw new Error('Synthetic broad screening did not settle');
  broadLifetime.abort();
  expect(() => agentResearchSourceOwner(admission.registry)?.capture(['Late broad private source'])).toThrow();
  expect(() => broad.project(broadReading.receipt)).toThrow();
  expect(agentResearchSourceOwner(admission.registry)).toBe(broad);
  const preview = await admission.run(createAgentResearchReportTool(store, f.owner), { ...report, preview: true });
  expect(preview.success, preview.error).toBe(true); expect(store.list()).toHaveLength(0);
  expect(agentResearchReportSourceOwner(admission.registry)).toBe(f.owner);
  expect(agentResearchSourceOwner(admission.registry)).toBe(broad);
});


test('native credential mutation onset retires an existing report before the write settles', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const original = await settled(f);
  const writing = f.secrets.set('SYNTHETIC_NEW_KEY', 'synthetic-replacement', { medium: 'plaintext', scope: 'user' });
  try {
    expect(f.secrets.getCredentialMutationState().pending).toBe(true);
    expect(() => f.owner.project(original.receipt)).toThrow();
    expect(() => f.owner.capture(['Report while native credentials are changing'])).toThrow();
  } finally { await writing; }
  await settled(f, 'New report after the exact credential write settles.');
  expect(() => f.owner.project(original.receipt)).toThrow();
});

test('explicit host consent preserves the complete deterministic credential and card floor', () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  expect(() => f.owner.capture(['Ordinary beginning', 'synthetic-research-typesafe', 'Ordinary ending'])).toThrow();
  expect(() => f.owner.capture(['Ordinary beginning', 'Card 4111 1111 1111 1111', 'Ordinary ending'])).toThrow();
  expect(f.calls).toHaveLength(0);
});


test.each(['report', 'reference'])(
  'retirement during exact native transport drain cannot publish a settled %s receipt', async role => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createTransport = screeningTransport.createScreeningTransport;
    const nativeTransports = new Set<ReturnType<typeof createTransport>>();
    const transportStub = spyOn(screeningTransport, 'createScreeningTransport').mockImplementation(options => {
      const native = createTransport(options); nativeTransports.add(native);
      return { ...native, async close() {
        await native.close(); entered.resolve(); await release.promise;
      } };
    });
    cleanup.push(async () => {
      release.resolve();
      await Promise.all([...nativeTransports].map(native => native.close()));
      transportStub.mockRestore();
    });
    const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
    cleanup.push(() => release.resolve());
    // Each handle remains bound to the real canonical source owner. Only its
    // completed native cleanup is held; no settled answer or receipt is invented.
    const read = role === 'report' ? (() => {
      const handle = f.owner.capture(['Synthetic source before native drain']);
      return { pending: f.owner.screen(handle), release: () => f.owner.release(handle) };
    })() : (() => {
      const handle = f.owner.captureResearchReference('https://example.test/native-drain');
      return { pending: f.owner.screenResearchReference(handle), release: () => f.owner.release(handle) };
    })();
    try { await entered.promise; f.config.getHostBooleanSetting(KEY).set(false); }
    finally { release.resolve(); }
    expect(await read.pending).toEqual({ status: 'held', reason: 'stale' });
    expect(() => f.owner.capture(['Report after revoked native consent'])).toThrow();
    await read.release();
  },
);


test.each(['cancel', 'retire', 'replace-options'])(
  'the original reference caller restriction survives native drain and %s', async role => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createTransport = screeningTransport.createScreeningTransport;
    const transportStub = spyOn(screeningTransport, 'createScreeningTransport').mockImplementation(options => {
      const native = createTransport(options);
      return { ...native, async close() {
        await native.close(); entered.resolve(); await release.promise;
      } };
    });
    cleanup.push(() => transportStub.mockRestore());
    const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
    cleanup.push(() => release.resolve());
    const caller = new AbortController();
    let current = true, checks = 0;
    const check = (): void => { checks++; if (!current) throw new Error('Original reference caller retired'); };
    const operation = { signal: caller.signal, assertCurrent: check };
    const handle = f.owner.captureResearchReference('https://example.test/original-reference-caller');
    const pending = f.owner.screenResearchReference(handle, operation);
    try {
      await entered.promise;
      const before = checks;
      if (role === 'cancel') caller.abort();
      else {
        current = false;
        if (role === 'replace-options') {
          operation.signal = new AbortController().signal;
          operation.assertCurrent = () => { throw new Error('Replacement caller must not run'); };
        }
      }
      release.resolve();
      expect(await pending).toEqual({ status: 'held', reason: role === 'cancel' ? 'cancelled' : 'stale' });
      if (role !== 'cancel') expect(checks).toBeGreaterThan(before);
      expect(f.calls).toHaveLength(0);
    } finally { release.resolve(); await pending; await f.owner.release(handle); }
  },
);

test('reference operation accessors and proxies cannot run while being retained', async () => {
  const f = fixture(); f.config.getHostBooleanSetting(KEY).set(true);
  const handle = f.owner.captureResearchReference('https://example.test/malformed-operation');
  let callbacks = 0;
  const accessor = Object.defineProperty({}, 'assertCurrent', { get() { callbacks++; return () => {}; } });
  const proxy = new Proxy({}, { ownKeys() { callbacks++; return []; }, get() { callbacks++; return undefined; } });
  expect(await f.owner.screenResearchReference(handle, accessor)).toEqual({ status: 'held', reason: 'malformed' });
  expect(await f.owner.screenResearchReference(handle, proxy)).toEqual({ status: 'held', reason: 'malformed' });
  expect(callbacks).toBe(0); expect(f.calls).toHaveLength(0);
  await f.owner.release(handle);
});
