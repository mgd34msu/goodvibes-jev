import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShareRuntimeCommands } from '../../input/commands/share-runtime.ts';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';
import { ScheduleReadingLifetime } from '../../input/commands/schedule-reading-lifetime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
const originalFetch = globalThis.fetch;
afterEach(() => { installJudgmentPort(previous); globalThis.fetch = originalFetch; getSharedNotificationFeed().clear(); });
function fixture() {
  const root = makeProjectTempDir('gv-share-reading');
  const lines: string[] = [];
  const registry = new CommandRegistry(); registerShareRuntimeCommands(registry);
  const calls: string[] = [];
  let generation = 0;
  const authHeaders = { 'X-API-Key': 'configured-literal' };
  const runtime = { model: 'synthetic-unpriced', provider: 'synthetic', sessionId: 'exact-session' };
  const lifetime = new ScheduleReadingLifetime(() => runtime.sessionId, () => true);
  const context = {
    shareReading: lifetime,
    print: (text: string) => lines.push(text),
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    platform: { serviceRegistry: { resolveAuth: async (name: string) => { calls.push(name); return authHeaders; } } },
    session: { runtime, conversationManager: { getReplacementGeneration: () => generation, title: 'Test export', toJSON: () => ({ messages: [{ role: 'user', content: 'hello' }] }) } },
  } as unknown as CommandContext;
  return { root, lines, calls, runtime, lifetime, authHeaders, replace: () => generation++, run: () => registry.get('share')!.handler(['json', 'session.json', '--upload'], context) };
}

test('real share command awaits a reading before sending exact configured token and repeats normally', async () => {
  const f = fixture();
  const fake = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(fake.port);
  const headers: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
    headers.push(new Headers(options?.headers).get('Authorization')!);
    return Response.json({ html_url: 'https://gist.github.com/synthetic' });
  }) as unknown as typeof fetch;
  await f.run(); await f.run();
  expect(headers).toEqual(['Bearer configured-literal', 'Bearer configured-literal']);
  expect(f.calls).toEqual(['github', 'github', 'github', 'github']);
  expect(f.lines.filter(line => line.includes('Share link:'))).toHaveLength(2);
  expect(readFileSync(join(f.root, 'session.json'), 'utf8')).toContain('hello');
});

test('failed reading uploads nothing, preserves local export, and a later retry recovers', async () => {
  const f = fixture(); let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
  previous = installJudgmentPort(fakePort(() => { throw new Error('unavailable'); }).port);
  await f.run();
  expect(uploads).toBe(0);
  expect(f.lines).toContain('Upload failed: credential-header reading unavailable. Local export saved.');
  expect(f.lines.some(line => line.startsWith('Exported JSON session'))).toBe(true);
  expect(readFileSync(join(f.root, 'session.json'), 'utf8')).toContain('hello');
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  await f.run(); expect(uploads).toBe(1);
});

for (const change of ['escape', 'session', 'exit', 'auth', 'conversation'] as const) {
  test(`pending share cannot upload after ${change}`, async () => {
    const f = fixture(); let uploads = 0;
    globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
    const fake = fakePort(() => noulAnswer(0.99));
    previous = installJudgmentPort({ ...fake.port, async ask(request) { requested(); await gate; return fake.port.ask(request); } });
    const pending = f.run(); await started;
    if (change === 'escape') f.lifetime.cancel();
    if (change === 'exit') f.lifetime.dispose();
    if (change === 'session') f.runtime.sessionId = 'other-session';
    if (change === 'conversation') f.replace();
    if (change === 'auth') f.authHeaders['X-API-Key'] = 'replacement';
    release(); await pending;
    expect(uploads).toBe(0);
    expect(readdirSync(f.root).filter(name => name.includes('.gist-'))).toEqual([]);
    expect(f.lines.some(line => line.includes('Share link:'))).toBe(false);
  });
}

test('repeated pending share owns one reading and one upload', async () => {
  const f = fixture(); let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ html_url: 'https://gist.github.com/synthetic' }); }) as unknown as typeof fetch;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  const fake = fakePort(() => noulAnswer(0.99));
  previous = installJudgmentPort({ ...fake.port, async ask(request) { requested(); await gate; return fake.port.ask(request); } });
  const pending = f.run(); await started;
  await f.run(); release(); await pending;
  expect(uploads).toBe(1); expect(fake.requests).toHaveLength(1);
});

for (const outcome of ['accepted', 'unconfirmed'] as const) {
  test(`revoked upload preserves ${outcome} receipt under original session without stale UI`, async () => {
    const f = fixture();
    previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let dispatched!: () => void; const started = new Promise<void>(resolve => { dispatched = resolve; });
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++; dispatched(); await gate;
      if (outcome === 'unconfirmed') throw new Error('connection ended before reply');
      return Response.json({ html_url: 'https://gist.github.com/accepted-before-cancel' });
    }) as unknown as typeof fetch;
    const pending = f.run(); await started;
    f.lifetime.cancel(); f.runtime.sessionId = 'replacement-session';
    const priorLines = [...f.lines]; release(); await pending;
    expect(requests).toBe(1); expect(f.lines).toEqual(priorLines);
    const receipts = readdirSync(f.root).filter(name => name.startsWith('session.json.gist-'));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(f.root, receipts[0]!), 'utf8'));
    expect(receipt.status).toBe(outcome); expect(receipt.sessionId).toBe('exact-session');
    if (outcome === 'accepted') expect(receipt.url).toBe('https://gist.github.com/accepted-before-cancel');
    else expect(receipt.url).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('configured-literal');
  });
}


test('accepted result survives receipt write failure as source-labelled notification, never stale chat or retry', async () => {
  const f = fixture(); previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++; f.lifetime.cancel(); f.runtime.sessionId = 'replacement-session';
    rmSync(f.root, { recursive: true, force: true }); writeFileSync(f.root, 'blocks receipt directory');
    return Response.json({ html_url: 'https://gist.github.com/accepted-without-durable-receipt' });
  }) as unknown as typeof fetch;
  await f.run();
  expect(requests).toBe(1);
  expect(f.lines.some(line => line.includes('Share link:'))).toBe(false);
  const notice = getSharedNotificationFeed().list().find(entry => entry.domain === 'share');
  expect(notice?.title).toBe('Gist accepted for session exact-session; receipt not saved');
  expect(notice?.body).toBe('https://gist.github.com/accepted-without-durable-receipt');
});
