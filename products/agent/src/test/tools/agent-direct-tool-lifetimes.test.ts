import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { profileDelegationForInvocation, assertCurrentProfileDelegation } from '@goodvibes-jev/engine/sdk/platform/owner-profile';
import { createShellPathService } from '@/runtime/index.ts';
import { createProfileGatewayInvoke } from '../../agent/owner-profile-gateway.ts';
import { createAgentProfileTool, registerAgentProfileTool } from '../../tools/agent-profile-tool.ts';
import { createAgentKnowledgeTool, registerAgentKnowledgeTool } from '../../tools/agent-knowledge-tool.ts';
import { createAgentSdk, getAgentKnowledgeJson } from '../../cli/agent-knowledge-runtime.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() {
  const path = makeProjectTempDir('agent-direct-lifetime'); directories.push(path); return path;
}
function knowledgeFixture() {
  const root = directory();
  const tokenPath = join(root, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: 'synthetic-direct-lifetime-token' }));
  const paths = createShellPathService({ homeDirectory: root, workingDirectory: root });
  let port = 3421;
  const config = { get(key: string) { return key === 'controlPlane.port' ? port : key === 'controlPlane.host' ? '127.0.0.1' : undefined; } };
  return { root, paths, config, tokenPath, changeHost() { port = 3422; } };
}
function profileStatus() {
  return { kind: 'loaded', path: 'synthetic-profile.md', exists: true, sections: [], lineCount: 0,
    fieldCount: 0, proseLineCount: 0, invalidFields: [] };
}
function response(action: string) {
  const data = action === 'status' ? { ready: true, sourceCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0, storagePath: 'knowledge-agent.sqlite' }
    : action === 'ask' ? { query: 'synthetic question', answer: { text: 'Retired answer must not publish.', mode: 'standard', confidence: 0,
      synthesized: false, sources: [], facts: [], linkedObjects: [], gaps: [] } }
    : action === 'search' ? { query: 'synthetic question', results: [] } : { sources: [] };
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Agent direct tool caller lifetime', () => {
  test('profile writes cannot manufacture native delegation with provenance flags', async () => {
    let calls = 0;
    const tool = createAgentProfileTool({ invoke: async () => { calls++; return { ok: true, data: {}, route: 'in-process' }; } });
    const result = await tool.execute({ action: 'set', fieldId: 'identity.name', value: 'Synthetic Owner',
      authority: 'owner-direct', said: 'save this', admission: 'autonomous' });
    expect(result.success).toBe(false);
    expect(calls).toBe(0);
  });

  test('registered profile writes bind native delegation and caller cancellation to the local invocation', async () => {
    const root = directory(), controller = new AbortController();
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    let called = false;
    catalog.register({ id: 'profile.set', title: 'Synthetic profile write', description: 'Disposable native handler',
      category: 'test', source: 'plugin', access: 'authenticated', transport: ['internal'], scopes: [] }, invocation => {
      expect(invocation.isAuthorized?.()).toBe(true);
      expect(invocation.context.principalKind).toBe('service');
      expect(invocation.signal?.aborted).toBe(false);
      const delegation = profileDelegationForInvocation(invocation);
      expect(delegation).toBeDefined();
      if (!delegation) throw new Error('Native profile delegation missing.');
      assertCurrentProfileDelegation(delegation);
      expect(invocation.body).toMatchObject({ fieldId: 'identity.name', authority: 'autonomous', said: '' });
      called = true;
      return { ok: true, reason: null, changes: [], disclosure: 'Saved synthetic owner.' };
    });
    const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, homeDirectory: root, configManager: { get() { return undefined; } } });
    const result = await admitLocalState(registry => registerAgentProfileTool(registry, { invoke }), 'profile',
      { action: 'set', fieldId: 'identity.name', value: 'Synthetic Owner' }, { directory: root, signal: controller.signal });
    expect(called).toBe(true);
    expect(result.success).toBe(true);
  });

  test('profile read cancellation during its native owner call prevents late publication', async () => {
    const controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const tool = createAgentProfileTool({ invoke: async (_method, _body, options) => {
      expect(options?.signal).toBe(controller.signal);
      entered.resolve(); await release.promise;
      return { ok: true, data: profileStatus(), route: 'in-process' };
    } });
    const pending = tool.execute({ action: 'status' }, { signal: controller.signal });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Profile returned before native owner entry.'); })]);
      controller.abort(); release.resolve();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.output).not.toContain('Profile: loaded');
    } finally { release.resolve(); await pending; }
  });

  test('replacing a profile backend while its read is pending cannot publish its result', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const deps = { invoke: async (): Promise<{ ok: boolean; data: unknown; route: 'in-process' }> => {
      entered.resolve(); await release.promise; return { ok: true, data: profileStatus(), route: 'in-process' };
    } };
    const pending = createAgentProfileTool(deps).execute({ action: 'status' });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Profile returned before native owner entry.'); })]);
      deps.invoke = async () => ({ ok: true, data: profileStatus(), route: 'in-process' });
      release.resolve();
      expect((await pending).success).toBe(false);
    } finally { release.resolve(); await pending; }
  });

  test('an already-cancelled Knowledge caller dispatches no request', async () => {
    const f = knowledgeFixture(), controller = new AbortController(); controller.abort();
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls++; return response('status'); });
    try {
      const result = await createAgentKnowledgeTool(f.paths, f.config).execute({ action: 'status' }, { signal: controller.signal });
      expect(result.success).toBe(false); expect(calls).toBe(0);
    } finally { globalThis.fetch = original; }
  });

  for (const action of ['status', 'ask', 'search', 'sources']) {
    test(`Knowledge ${action} retains the original caller through its response`, async () => {
      const f = knowledgeFixture(), controller = new AbortController();
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const original = globalThis.fetch; let calls = 0, alive = true;
      globalThis.fetch = mockFetch(async (_input, init) => {
        calls++; expect(init?.signal).toBeDefined(); expect(init?.signal?.aborted).toBe(false);
        entered.resolve(); await release.promise; return response(action);
      });
      const pending = createAgentKnowledgeTool(f.paths, f.config).execute({ action, query: 'synthetic question' },
        { signal: controller.signal, assertCurrent() { if (!alive) throw new Error('Caller retired.'); } });
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Knowledge returned before transport entry.'); })]);
        alive = false; controller.abort(); release.resolve();
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.output).toBeUndefined();
        expect(result.error).toEqual(expect.any(String));
        expect(result.error).not.toContain('Retired answer');
        expect(calls).toBe(1);
      } finally { release.resolve(); await pending; globalThis.fetch = original; }
    });
  }

  test('a replaced selected host holds a pending Knowledge read', async () => {
    const f = knowledgeFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls++; entered.resolve(); await release.promise; return response('status'); });
    const pending = createAgentKnowledgeTool(f.paths, f.config).execute({ action: 'status' });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Knowledge returned before transport entry.'); })]);
      f.changeHost(); release.resolve();
      expect((await pending).success).toBe(false); expect(calls).toBe(1);
    } finally { release.resolve(); await pending; globalThis.fetch = original; }
  });

  test('retirement before a Knowledge 404 prevents compatibility probing', async () => {
    const f = knowledgeFixture(), original = globalThis.fetch; let alive = true, calls = 0;
    globalThis.fetch = mockFetch(async () => { calls++; alive = false; return new Response('{}', { status: 404 }); });
    try {
      const result = await createAgentKnowledgeTool(f.paths, f.config).execute({ action: 'sources' },
        { assertCurrent() { if (!alive) throw new Error('Caller retired.'); } });
      expect(result.success).toBe(false); expect(calls).toBe(1);
    } finally { globalThis.fetch = original; }
  });

  test('the GET adapter checks the original caller after its response body completes', async () => {
    const f = knowledgeFixture(), original = globalThis.fetch, entered = Promise.withResolvers<void>();
    const body = Promise.withResolvers<void>(); let alive = true;
    class DeferredResponse extends Response {
      override async text() { entered.resolve(); await body.promise; return super.text(); }
    }
    globalThis.fetch = mockFetch(async () => new DeferredResponse('{"sources":[]}', { status: 200 }));
    const pending = getAgentKnowledgeJson({ baseUrl: 'http://127.0.0.1:3421', token: 'synthetic-token', tokenPath: f.tokenPath },
      '/api/goodvibes-agent/knowledge/sources', {}, { assertCurrent() { if (!alive) throw new Error('Caller retired.'); } });
    const observed = pending.then(() => false, () => true);
    try {
      await Promise.race([entered.promise, observed.then(() => { throw new Error('Knowledge returned before response-body entry.'); })]);
      alive = false; body.resolve();
      expect(await observed).toBe(true);
    } finally { body.resolve(); await observed; globalThis.fetch = original; }
  });

  test('registered Knowledge capture cannot adopt a changed host after preparation', async () => {
    const f = knowledgeFixture(), original = globalThis.fetch; let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls++; return response('status'); });
    try {
      const result = await admitLocalState(registry => registerAgentKnowledgeTool(registry, f.paths, f.config),
        'agent_knowledge', { action: 'status' }, { directory: f.root, afterCapture: f.changeHost });
      expect(result.success).toBe(false); expect(calls).toBe(0);
    } finally { globalThis.fetch = original; }
  });
});

function unfinishedGuard(kind: 'pending' | 'nonvoid' | 'thenable') {
  const pending = Promise.withResolvers<void>();
  let calls = 0, thenReads = 0;
  const borrowed = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('Borrowed thenable evaluated.'); } });
  return {
    assertCurrent() { calls++; return kind === 'pending' ? pending.promise : kind === 'nonvoid' ? 'unfinished' : borrowed; },
    calls() { return calls; }, thenReads() { return thenReads; },
    async drain() { pending.resolve(); await pending.promise; },
  };
}
function statusGateway(onInvoke: () => void) {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register({ id: 'profile.status', title: 'Synthetic direct status', description: 'Disposable native handler',
    category: 'test', source: 'plugin', access: 'authenticated', transport: ['internal'], scopes: [] }, () => {
    onInvoke(); return profileStatus();
  });
  return createProfileGatewayInvoke({ gatewayMethods: catalog, homeDirectory: directory(), configManager: { get() { return undefined; } } });
}

describe('direct gateway and SDK synchronous lifetime ingress', () => {
  for (const kind of ['pending', 'nonvoid', 'thenable'] as const) {
    test(`direct profile gateway refuses a ${kind} guard before native dispatch`, async () => {
      const guard = unfinishedGuard(kind); let dispatches = 0;
      const invoke = statusGateway(() => { dispatches++; });
      const observed = invoke('profile.status', {}, { assertCurrent: guard.assertCurrent }).then(() => false, () => true);
      try {
        expect(await observed).toBe(true);
        expect(dispatches).toBe(0); expect(guard.calls()).toBe(1); expect(guard.thenReads()).toBe(0);
      } finally { await guard.drain(); await observed; }
    });

    test(`direct Knowledge SDK refuses a ${kind} guard before fetch`, async () => {
      const guard = unfinishedGuard(kind), original = globalThis.fetch; let requests = 0;
      globalThis.fetch = mockFetch(async () => { requests++; return response('status'); });
      try {
        expect(() => createAgentSdk({ baseUrl: 'http://127.0.0.1:3421', token: 'synthetic-token', tokenPath: 'synthetic-token-file' },
          { assertCurrent: guard.assertCurrent })).toThrow();
        expect(requests).toBe(0); expect(guard.calls()).toBe(1); expect(guard.thenReads()).toBe(0);
      } finally { await guard.drain(); globalThis.fetch = original; }
    });
  }

  test('direct profile gateway accepts a synchronous void lifetime and checks it through dispatch', async () => {
    let checks = 0, dispatches = 0;
    const invoke = statusGateway(() => { dispatches++; expect(checks).toBeGreaterThan(0); });
    const result = await invoke('profile.status', {}, { assertCurrent() { checks++; } });
    expect(result.ok).toBe(true); expect(dispatches).toBe(1); expect(checks).toBeGreaterThan(1);
  });

  test('direct Knowledge SDK accepts a synchronous void lifetime and checks the actual response', async () => {
    const original = globalThis.fetch; let checks = 0, requests = 0;
    globalThis.fetch = mockFetch(async () => { requests++; expect(checks).toBeGreaterThan(0); return response('status'); });
    try {
      const sdk = createAgentSdk({ baseUrl: 'http://127.0.0.1:3421', token: 'synthetic-token', tokenPath: 'synthetic-token-file' },
        { assertCurrent() { checks++; } });
      const result = await sdk.knowledge.status();
      expect(result.ready).toBe(true); expect(requests).toBe(1); expect(checks).toBeGreaterThan(1);
    } finally { globalThis.fetch = original; }
  });
});
