import { afterEach, expect, test } from 'bun:test';
import { executeFetchInput } from '../sdk/src/platform/tools/fetch/runtime.js';
import { withExternalOperationSource } from '../sdk/src/platform/permissions/external-operation-scope.js';

const originalFetch = globalThis.fetch;
const source = { sourceOf: () => ({ goal: 'Read the local preview', criteria: ['Only this request'] }), assertCurrent() {} };
afterEach(() => { globalThis.fetch = originalFetch; });

test('autonomous localhost does not inherit a persistent grant or legacy boolean approval', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; return new Response('unsafe'); }) as typeof fetch;
  for (const configured of [false, true]) {
    const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://127.0.0.1/' }] }, {
      isLocalhostAllowed: () => configured,
      approveLocalhostFetch: async () => true,
    }));
    expect(output.results?.[0]?.error).toBeDefined();
  }
  expect(sends).toBe(0);
});

import { beforeEach } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { buildLocalhostFetchApproval, type LocalhostFetchApprovalInput, type LocalhostFetchPermit } from '../sdk/src/platform/runtime/permissions/localhost-fetch-approval.js';
import { admitLocalhostFetch } from '../sdk/src/platform/runtime/permissions/autonomous-localhost-fetch.js';
import type { AutonomousToolPromptHost } from '../sdk/src/platform/runtime/permissions/autonomous-tool-prompts.js';

let log: SqliteDecisionLog;
let restore: ReturnType<typeof installJudgmentPort>;
let host: AutonomousToolPromptHost;
let selected: string;
let invalidations: Set<() => void>;
let judgments: string[];
let humans: number;
let writes: number;
let admissions: number;
beforeEach(() => {
  selected = 'act'; humans = 0; writes = 0; admissions = 0; invalidations = new Set(); judgments = [];
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort();
  const semantic = fakePort((_name, question) => choiceAnswer(question, selected, 0.99));
  const port: JudgmentPort = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.beforeAttempt?.(); request.signal?.throwIfAborted(); judgments.push(JSON.stringify(request));
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  restore = installJudgmentPort(port);
  const config = {
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/project',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project' }),
  } as PermissionConfigReader;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human'); }, config, new PolicyRuntimeState());
  host = { port, workspaceTrust: null,
    permissionManager: { admitAutonomous(...args) { admissions++; return manager.admitAutonomous(...args); } },
    signal: new AbortController().signal,
    config: { onDidInvalidate(listener) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } },
  };
});
afterEach(() => { installJudgmentPort(restore); log[Symbol.dispose](); forgetGateReadings(); });
function approval() {
  return buildLocalhostFetchApproval({ autonomousHost: host,
    requestApproval: async () => { humans++; return { approved: true }; },
    configManager: { get: () => true, setProjectValue: () => { writes++; } } as Parameters<typeof buildLocalhostFetchApproval>[0]['configManager'],
  });
}
function fetchLocal(url = 'http://localhost/start', extra: Parameters<typeof executeFetchInput>[1] = {}) {
  return withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url }] }, {
    approveLocalhostFetch: approval(), isLocalhostAllowed: () => true,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], ...extra,
  }));
}
function request(): LocalhostFetchApprovalInput {
  return { url: 'http://localhost/path', host: 'localhost', request: { url: 'http://localhost/path', method: 'GET' }, originalRequest: { url: 'http://localhost/path' } };
}
async function permit(input = request()): Promise<LocalhostFetchPermit> {
  const result = await withExternalOperationSource(source, () => admitLocalhostFetch(host, input, { assertCurrent() {} }));
  expect(result).not.toBe(false);
  if (result === false) throw new Error('Expected admission');
  return result;
}

test('canonical admission records every redirect hop without human or persistent grant', async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (url) => {
    paths.push(new URL(String(url)).pathname);
    return paths.length === 1 ? new Response('', { status: 302, headers: { location: '/second' } }) : new Response('done');
  }) as typeof fetch;
  const output = await fetchLocal();
  expect(output.results?.[0]?.error).toBeUndefined();
  expect(paths).toEqual(['/start', '/second']); expect(admissions).toBe(2);
  expect(humans).toBe(0); expect(writes).toBe(0); expect(invalidations.size).toBe(0);
});

test('typed reject refuses despite stored allow and never prompts', async () => {
  selected = 'reject'; let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; return new Response('unsafe'); }) as typeof fetch;
  const output = await fetchLocal();
  expect(output.results?.[0]?.error).toBeDefined(); expect(sends).toBe(0); expect(admissions).toBe(1);
  expect(humans).toBe(0); expect(writes).toBe(0); expect(invalidations.size).toBe(0);
});

test('permit is frozen, one-use, revocable after claim, and closes listeners', async () => {
  const admitted = await permit(); expect(Object.isFrozen(admitted)).toBe(true);
  admitted.claim(); expect(() => admitted.claim()).toThrow(); expect(invalidations.size).toBe(1);
  for (const invalidate of invalidations) invalidate();
  expect(admitted.signal.aborted).toBe(true); expect(() => admitted.assertCurrent()).toThrow();
  admitted.close(); admitted.close(); expect(invalidations.size).toBe(0);
});

test('mutated exact prepared request cannot be claimed', async () => {
  const input = request(); const admitted = await permit(input);
  input.request!.url = 'http://localhost/different';
  expect(() => admitted.claim()).toThrow(); admitted.close(); expect(invalidations.size).toBe(0);
});

test('config invalidation during checked DNS prevents the final socket claim', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; return new Response('unsafe'); }) as typeof fetch;
  const output = await fetchLocal('http://localhost/', { resolveHost: async () => {
    for (const invalidate of invalidations) invalidate();
    return [{ address: '127.0.0.1', family: 4 }];
  } });
  expect(output.results?.[0]?.error).toBeDefined(); expect(sends).toBe(0); expect(invalidations.size).toBe(0);
});

test('source replacement during first address failure prevents every later retry', async () => {
  let sends = 0; let current = true;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; current = false; throw new Error('connection refused'); }) as typeof fetch;
  const output = await withExternalOperationSource({ ...source, assertCurrent() { if (!current) throw new Error('replaced'); } }, () => executeFetchInput({ urls: [{ url: 'http://localhost/' }] }, {
    approveLocalhostFetch: approval(), resolveHost: async () => [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toContain('replaced'); expect(sends).toBe(1); expect(invalidations.size).toBe(0);
});

test('effective redirect request describes GET without stale params or body; original stays labeled', async () => {
  const seen: LocalhostFetchApprovalInput[] = []; let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => ++sends === 1 ? new Response('', { status: 303, headers: { location: '/target' } }) : new Response('done')) as typeof fetch;
  const approve = approval();
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/start', params: { x: '1' }, method: 'POST', body: 'payload' }] }, {
    approveLocalhostFetch: (input, context) => { seen.push(input); return approve(input, context); },
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toBeUndefined();
  expect(seen[0]?.request).toMatchObject({ url: 'http://localhost/start?x=1', method: 'POST', body: 'payload' });
  expect(seen[1]?.request).toEqual({ url: 'http://localhost/target', method: 'GET', headers: {} });
  expect(seen[1]?.originalRequest).toMatchObject({ params: { x: '1' }, method: 'POST', body: 'payload' });
});

test('stored service credentials reach only the wire, not the judgment', async () => {
  let authorization: string | null = null;
  globalThis.fetch = (async (_url, init) => { authorization = new Headers(init?.headers).get('authorization'); return new Response('done'); }) as typeof fetch;
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/', service: 'preview' }] }, {
    approveLocalhostFetch: approval(), serviceRegistry: { resolveAuth: async () => ({ Authorization: 'Bearer stored-secret-value' }) },
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toBeUndefined(); expect(String(authorization)).toBe('Bearer stored-secret-value');
  expect(judgments.join('\n')).not.toContain('stored-secret-value'); expect(judgments.join('\n')).toContain('credentialHeaderNames');
});

test('inline model credentials fail closed before judgment or socket', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; return new Response('unsafe'); }) as typeof fetch;
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/', auth: { type: 'bearer', token: 'model-secret' } }] }, {
    approveLocalhostFetch: approval(), resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toBeDefined(); expect(sends).toBe(0); expect(admissions).toBe(0);
  expect(judgments.join('\n')).not.toContain('model-secret'); expect(invalidations.size).toBe(0);
});

test('config invalidation during address failure prevents retry after the claim', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; for (const invalidate of invalidations) invalidate(); throw new Error('connection refused'); }) as typeof fetch;
  const output = await fetchLocal('http://localhost/', { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }] });
  expect(output.results?.[0]?.error).toBeDefined(); expect(sends).toBe(1); expect(invalidations.size).toBe(0);
});

test('each 401 credential refresh uses a fresh exact admission with no stored secret in judgment', async () => {
  let sends = 0; let reads = 0; const seen: string[] = [];
  globalThis.fetch = (async (_url, init) => { seen.push(new Headers(init?.headers).get('authorization')!); return ++sends === 1 ? new Response('', { status: 401 }) : new Response('done'); }) as typeof fetch;
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/', service: 'preview' }] }, {
    approveLocalhostFetch: approval(), serviceRegistry: { resolveAuth: async () => ({ Authorization: `Bearer stored-secret-${++reads}` }) },
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toBeUndefined(); expect(admissions).toBe(2);
  expect(seen).toEqual(['Bearer stored-secret-1', 'Bearer stored-secret-2']);
  expect(judgments.join('\n')).not.toContain('stored-secret-'); expect(invalidations.size).toBe(0);
});

test('mixed private DNS after admission is blocked without any socket', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { sends++; return new Response('unsafe'); }) as typeof fetch;
  const output = await fetchLocal('http://localhost/', { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  expect(output.results?.[0]?.error).toContain('private'); expect(sends).toBe(0); expect(admissions).toBe(1); expect(invalidations.size).toBe(0);
});

test('public redirect into loopback and public names rebinding to loopback remain hard-blocked', async () => {
  let sends = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => ++sends === 1 ? new Response('', { status: 302, headers: { location: 'http://localhost/target' } }) : new Response('done')) as typeof fetch;
  const output = await fetchLocal('http://public.test/', { resolveHost: async name => [{ address: name === 'localhost' ? '127.0.0.1' : '203.0.113.10', family: 4 }] });
  expect(output.results?.[0]?.error).toContain('Redirect blocked'); expect(sends).toBe(1); expect(admissions).toBe(0);
  const rebound = await fetchLocal('http://public.test/');
  expect(rebound.results?.[0]?.error).toContain('loopback'); expect(sends).toBe(1); expect(admissions).toBe(0);
});

test('missing workspace capability, originating source, context, or recorder fails closed', async () => {
  const input = request();
  expect(await admitLocalhostFetch(host, input, { assertCurrent() {} })).toBe(false);
  expect(await withExternalOperationSource(source, () => admitLocalhostFetch(host, input))).toBe(false);
  expect(await withExternalOperationSource(source, () => admitLocalhostFetch({ ...host, workspaceTrust: undefined }, input, { assertCurrent() {} }))).toBe(false);
  expect(await withExternalOperationSource(source, () => admitLocalhostFetch({ ...host, port: { ask: host.port.ask, model: host.port.model } }, input, { assertCurrent() {} }))).toBe(false);
  expect(admissions).toBe(0); expect(invalidations.size).toBe(0);
});

test('revocation during response consumption remains live until permit close', async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response(new ReadableStream({ pull(controller) {
    for (const invalidate of invalidations) invalidate(); controller.enqueue(new TextEncoder().encode('late')); controller.close();
  } }))) as typeof fetch;
  const output = await fetchLocal();
  expect(output.results?.[0]?.error).toBeDefined(); expect(output.results?.[0]?.content).toBeUndefined(); expect(invalidations.size).toBe(0);
});

test('cross-origin admission reflects removed credentials and preserved 307 body', async () => {
  const seen: LocalhostFetchApprovalInput[] = []; let sends = 0;
  globalThis.fetch = (async (_url, init) => {
    sends++;
    if (sends === 1) return new Response('', { status: 307, headers: { location: 'http://other.localhost/target' } });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.body).toBe('exact body'); return new Response('done');
  }) as typeof fetch;
  const approve = approval();
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/start', method: 'POST', body: 'exact body', service: 'preview' }] }, {
    approveLocalhostFetch: (input, context) => { seen.push(input); return approve(input, context); },
    serviceRegistry: { resolveAuth: async () => ({ Authorization: 'Bearer stored-secret' }) },
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.results?.[0]?.error).toBeUndefined(); expect(admissions).toBe(2);
  expect(seen[1]?.request).toEqual({ url: 'http://other.localhost/target', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'exact body' });
  expect(judgments.join('\n')).not.toContain('stored-secret');
});

test('source revision or workspace capability replacement revokes an unclaimed permit', async () => {
  let goal = 'Read localhost'; const operation = { sourceOf: () => ({ goal, criteria: [] }), assertCurrent() {} };
  const admitted = await withExternalOperationSource(operation, () => admitLocalhostFetch(host, request(), { assertCurrent() {} }));
  if (admitted === false) throw new Error('Expected permit');
  goal = 'New goal'; expect(() => admitted.claim()).toThrow(); admitted.close();
  const second = await permit();
  Object.assign(host, { workspaceTrust: { prepareAutonomousConstraint: async () => () => {} } });
  expect(() => second.claim()).toThrow(); second.close(); expect(invalidations.size).toBe(0);
});

test('all local batch requests get independent admissions instead of one legacy single-flight grant', async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response('done')) as typeof fetch;
  const output = await withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/one' }, { url: 'http://localhost/two' }] }, {
    approveLocalhostFetch: approval(), resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  expect(output.summary.failed).toBe(0); expect(admissions).toBe(2); expect(invalidations.size).toBe(0);
});

test('final one-use claim happens after checked DNS, never on refused DNS', async () => {
  const events: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { events.push('send'); return new Response('done'); }) as typeof fetch;
  const run = (address: string) => withExternalOperationSource(source, () => executeFetchInput({ urls: [{ url: 'http://localhost/' }] }, {
    approveLocalhostFetch: async () => {
      events.push('admit');
      return Object.freeze({ signal: new AbortController().signal, assertCurrent() {}, claim() { events.push('claim'); }, close() { events.push('close'); } });
    },
    resolveHost: async () => { events.push('dns'); return [{ address, family: 4 }]; },
  }));
  expect((await run('127.0.0.1')).results?.[0]?.error).toBeUndefined();
  expect(events).toEqual(['admit', 'dns', 'claim', 'send', 'close']); events.length = 0;
  expect((await run('169.254.169.254')).results?.[0]?.error).toContain('metadata');
  expect(events).toEqual(['admit', 'dns', 'close']);
});

test('prepared wire hashing refuses executable input without invoking serialization hooks', async () => {
  let invoked = false; const input = request();
  Object.assign(input.request!, { toJSON() { invoked = true; return {}; } });
  const result = await withExternalOperationSource(source, () => admitLocalhostFetch(host, input, { assertCurrent() {} }));
  expect(result).toBe(false); expect(invoked).toBe(false); expect(admissions).toBe(0); expect(invalidations.size).toBe(0);
});
