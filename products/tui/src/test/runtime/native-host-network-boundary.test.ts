import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { revalidateNativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { createNativeHostFetch } from '../../runtime/client/native-host-fetch.ts';
import { createNativeWorkSubmissionBinding } from '../../runtime/native-work-submission-host.ts';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';
import { createNativeWorkLedgerHost } from '../../runtime/native-work-ledger-host.ts';
import { executeNativeHeadless } from '../../cli/native-headless.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTuiLegacyImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { pairNativeTestHost, replaceNativeTestCredential } from '../helpers/native-host-pairing.ts';

const auth = { authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
  principalId: 'redirected-principal', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger', 'read:knowledge'], roles: [] };
const target = { workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } };
const source = { requestId: 'request', inputId: 'input', text: 'Original private source', unsupportedSources: [] };
const turn = { kind: 'turn' as const, projectId: 'project', requestId: 'request', sourceRef: { version: 1 as const, inputId: 'input', sourceId: 'source', sourceRevision: 'r1', sessionId: 'session' }, route: 'answer' as const, text: source.text };

async function redirectFixture(status = 307, sameOrigin = false) {
  const home = mkdtempSync(join(tmpdir(), 'native-network-boundary-'));
  const delivered: { method: string; body: string }[] = []; const requested: { path: string; method: string; body: string }[] = [];
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    delivered.push({ method: request.method, body: await request.text() }); return Response.json(auth);
  } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/redirected') { delivered.push({ method: request.method, body: await request.text() }); return Response.json(auth); }
    requested.push({ path, method: request.method, body: await request.text() });
    const origin = sameOrigin ? new URL(request.url).origin : `http://127.0.0.1:${destination.port}`;
    return new Response(null, { status, headers: { location: `${origin}/redirected` } });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  await pairNativeTestHost(home, baseUrl, 'private-origin-token');
  const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? baseUrl : undefined } as unknown as ConfigManager;
  const host = { baseUrl, token: 'private-origin-token', workspace: home, journalPath: join(home, 'intake.json') };
  return { home, host, configManager, delivered, requested, close() { server.stop(true); destination.stop(true); rmSync(home, { recursive: true, force: true }); } };
}

test('native fetch cannot be instructed to follow redirects and checks before every fetch', async () => {
  let current = true; const redirects: (RequestRedirect | undefined)[] = [];
  const guarded = createNativeHostFetch({ current: () => current, fetchImpl: async (_url, init) => { redirects.push(init?.redirect); return new Response('{}'); } });
  await guarded('http://host.invalid', { redirect: 'follow' }); current = false;
  await expect(guarded('http://host.invalid', { method: 'POST', body: 'source' })).rejects.toThrow();
  expect(redirects).toEqual(['error']);
});

for (const sameOrigin of [false, true]) test(`native auth refuses ${sameOrigin ? 'same' : 'cross'}-origin redirects instead of accepting the redirected principal`, async () => {
  const f = await redirectFixture(302, sameOrigin);
  const submission = createNativeWorkSubmissionBinding(f.host, 'project'); const intake = createNativeConversationIntakeBinding(f.host, 'project');
  try {
    await expect(submission.readPrincipal(new AbortController().signal)).rejects.toThrow();
    await expect(intake.readPrincipal(new AbortController().signal)).rejects.toThrow();
    expect(f.requested.map(request => request.path)).toEqual(['/api/control-plane/auth', '/api/control-plane/auth']); expect(f.delivered).toEqual([]);
  } finally { submission.dispose(); intake.dispose(); f.close(); }
});

for (const status of [307, 308]) test(`native POST bodies never cross a ${status} redirect`, async () => {
  const f = await redirectFixture(status);
  const submission = createNativeWorkSubmissionBinding(f.host, 'project'); const intake = createNativeConversationIntakeBinding(f.host, 'project');
  try {
    await expect(submission.client.submit({ requestId: 'request', inputId: 'input', expectedRevision: 0, goal: source.text, criteria: ['Exact criterion'] })).rejects.toThrow();
    await expect(intake.client.capture(source)).rejects.toThrow();
    await expect(intake.execution.start(target)).rejects.toThrow();
    expect(f.requested).toHaveLength(3); expect(f.requested.every(request => request.method === 'POST')).toBe(true);
    expect(f.requested[0]!.body).toContain(source.text); expect(f.requested[1]!.body).toContain(source.text);
    expect(f.delivered).toEqual([]);
  } finally { submission.dispose(); intake.dispose(); f.close(); }
});

test('native ledger discovery, readers and execution refuse redirected authority', async () => {
  const f = await redirectFixture();
  const host = createNativeWorkLedgerHost({ configManager: f.configManager, homeDirectory: f.home, workspace: () => f.home });
  let binding: ReturnType<Extract<ReturnType<typeof host.readSelection>, { available: true }>['bind']> | undefined;
  try {
    await host.discoverProject(); expect(host.readSelection().available).toBe(false);
    host.selectProject('project'); const selected = host.readSelection(); if (!selected.available) throw new Error('Missing fixture selection');
    binding = selected.bind(() => {}); if (!binding.available) throw new Error('Missing fixture binding');
    await expect(binding.client.readSnapshot()).rejects.toThrow();
    await expect(binding.client.history(0)).rejects.toThrow();
    await expect(binding.execution!.start(target)).rejects.toThrow();
    expect(f.requested).toHaveLength(4); expect(f.delivered).toEqual([]);
  } finally { if (binding?.available) { binding.execution?.dispose(); binding.client.dispose(); } f.close(); }
});

test('native headless discovery never accepts a redirected project', async () => {
  const f = await redirectFixture();
  try {
    const result = await executeNativeHeadless({ mode: 'submit', prompt: source.text, signal: new AbortController().signal, resolveHost: () => f.host,
      runTurn: async () => { throw new Error('Redirected authority cannot dispatch a turn'); } });
    expect(result.exitCode).toBe(1); expect(f.requested.map(request => request.path)).toEqual(['/api/work-ledger/project']); expect(f.delivered).toEqual([]);
  } finally { f.close(); }
});

test('legacy read adapter never accepts a redirected principal', async () => {
  const f = await redirectFixture(); const lines: string[] = [];
  try {
    const registry = new CommandRegistry(); registerTuiLegacyImportCommands(registry);
    const context = { platform: { configManager: f.configManager }, workspace: { shellPaths: createShellPathService({ workingDirectory: f.home, homeDirectory: f.home }) }, print: (line: string) => lines.push(line) } as unknown as CommandContext;
    await registry.execute('work-import', ['status', 'project'], context);
    expect(lines.join('\n')).toContain('Legacy import read unavailable'); expect(lines.join('\n')).not.toContain('redirected-principal');
    expect(f.requested.map(request => request.path)).toEqual(['/api/control-plane/auth']); expect(f.delivered).toEqual([]);
  } finally { f.close(); }
});

for (const action of ['submission-principal', 'intake-principal', 'submission-post', 'intake-post', 'intake-execution'] as const) test(`final fetch boundary fences ${action} invalidation after invoke starts`, async () => {
  let current = true; let checks = 0; let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json(auth); } });
  const host = { baseUrl: `http://127.0.0.1:${server.port}`, token: 'old-private-token', workspace: '/unused' };
  const isCurrent = () => { checks++; return current; };
  const submission = createNativeWorkSubmissionBinding(host, 'project', isCurrent); const intake = createNativeConversationIntakeBinding(host, 'project', isCurrent);
  try {
    const pending = action === 'submission-principal' ? submission.readPrincipal(new AbortController().signal)
      : action === 'intake-principal' ? intake.readPrincipal(new AbortController().signal)
      : action === 'submission-post' ? submission.client.submit({ requestId: 'request', inputId: 'input', expectedRevision: 0, goal: source.text, criteria: ['Exact'] })
      : action === 'intake-post' ? intake.client.capture(source) : intake.execution.start(target);
    await Promise.resolve(); expect(checks).toBeGreaterThan(0); current = false;
    await expect(pending).rejects.toThrow(); expect(requests).toBe(0);
  } finally { submission.dispose(); intake.dispose(); server.stop(true); }
});

for (const action of ['reader', 'execution', 'discovery', 'headless', 'legacy'] as const) test(`final fetch boundary fences ${action} after private credential replacement`, async () => {
  const f = await redirectFixture(); const host = createNativeWorkLedgerHost({ configManager: f.configManager, homeDirectory: f.home, workspace: () => f.home });
  let binding: ReturnType<Extract<ReturnType<typeof host.readSelection>, { available: true }>['bind']> | undefined;
  try {
    let pending: Promise<unknown>;
    if (action === 'reader' || action === 'execution') {
      host.selectProject('project'); const selected = host.readSelection(); if (!selected.available) throw new Error('Missing fixture selection');
      binding = selected.bind(() => {}); if (!binding.available) throw new Error('Missing fixture binding');
      pending = action === 'reader' ? binding.client.readSnapshot() : binding.execution!.start(target);
    } else if (action === 'discovery') pending = host.discoverProject();
    else if (action === 'headless') pending = executeNativeHeadless({ mode: 'submit', prompt: source.text, signal: new AbortController().signal,
      resolveHost: () => ({ ...f.host, credentialIdentity: host.readSelection().identity }), runTurn: async () => { throw new Error('Unexpected turn'); } });
    else {
      const registry = new CommandRegistry(); registerTuiLegacyImportCommands(registry);
      const context = { platform: { configManager: f.configManager }, workspace: { shellPaths: createShellPathService({ workingDirectory: f.home, homeDirectory: f.home }) }, print() {} } as unknown as CommandContext;
      pending = registry.execute('work-import', ['status', 'project'], context);
    }
    await Promise.resolve(); replaceNativeTestCredential(f.home);
    await pending.catch(() => undefined); expect(f.requested).toEqual([]); expect(f.delivered).toEqual([]);
  } finally { if (binding?.available) { binding.execution?.dispose(); binding.client.dispose(); } f.close(); }
});

test('queued turn revalidation fences SDK gaps and refuses redirects even after intake disposal', async () => {
  let current = true; let redirect = false; let requests = 0; let delivered = 0;
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { delivered++; return Response.json(turn); } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return redirect ? new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/turn` } }) : Response.json(turn); } });
  const intake = createNativeConversationIntakeBinding({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'private-token', workspace: '/unused' }, 'project', () => current);
  try {
    const result = await intake.client.capture(source); const permit = intake.client.bindTurn(result); intake.dispose();
    const pending = revalidateNativeConversationTurnPermit(permit); current = false;
    await expect(pending).rejects.toThrow(); expect(requests).toBe(1);
    current = true; redirect = true;
    await expect(revalidateNativeConversationTurnPermit(permit)).rejects.toThrow(); expect(requests).toBe(2); expect(delivered).toBe(0);
  } finally { intake.dispose(); server.stop(true); other.stop(true); }
});

for (const kind of ['submission', 'intake'] as const) test(`disposing ${kind} during SDK middleware prevents its principal request`, async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json(auth); } });
  const host = { baseUrl: `http://127.0.0.1:${server.port}`, token: 'private-token', workspace: '/unused' };
  const binding = kind === 'submission' ? createNativeWorkSubmissionBinding(host, 'project') : createNativeConversationIntakeBinding(host, 'project');
  try {
    const pending = binding.readPrincipal(new AbortController().signal); binding.dispose();
    await expect(pending).rejects.toThrow(); expect(requests).toBe(0);
  } finally { binding.dispose(); server.stop(true); }
});


test('SDK retry rechecks the selection at fetch rather than resending the captured bearer', async () => {
  let current = true; let requests = 0; let retries = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ error: 'Retry fixture' }, { status: 503 }); } });
  const operator = createOperatorSdk({ baseUrl: `http://127.0.0.1:${server.port}`, authToken: 'private-token', fetchImpl: createNativeHostFetch({ current: () => current }),
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, onRetryScheduled() { retries++; current = false; } });
  try {
    await expect(operator.control.auth.current({})).rejects.toThrow(); expect(retries).toBe(1); expect(requests).toBe(1);
  } finally { operator.dispose(); server.stop(true); }
});
