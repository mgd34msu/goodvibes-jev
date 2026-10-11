import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import { runNativeMutation } from '../sdk/src/platform/control-plane/native-mutation.js';
import { normalizeContext } from '../sdk/src/platform/control-plane/host-handlers.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { PermissionManager, createPermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { runDeliveryPublication, type DeliveryLifetime } from '../sdk/src/platform/utils/delivery-lifetime.js';
import type { MutationPublication } from '../sdk/src/platform/utils/file-mutation.js';
import { pinnedFetch } from '../sdk/src/platform/tools/fetch/pinned-request.js';
import { deliverToSubscription } from '../sdk/src/platform/push/delivery.js';
import { PushSubscriptionStore } from '../sdk/src/platform/push/subscription-store.js';
import type { VapidManager } from '../sdk/src/platform/push/vapid.js';
import { SmtpClient } from '../sdk/src/platform/email/smtp-client.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';

const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog;
let previous: ReturnType<typeof installJudgmentPort>;
let port: JudgmentPort;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort();
  const semantic = fakePort((_name, question) => choiceAnswer(question,
    question.type === 'choice' && Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject', 0.99));
  port = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gv-native-send-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'test-native-send' });
  const invalidations = new Set<() => void>(), signal = new AbortController();
  let humans = 0;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human fallback'); },
    createPermissionConfigReader(config), new PolicyRuntimeState());
  const host = { permissionManager: manager, port, workspaceTrust: null, workspaceRoot: directory, signal: signal.signal,
    config: { onDidInvalidate(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } } };
  const pairing = new PairingTokenManager(join(directory, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic local send' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), pairingTokens: pairing,
    authToken: () => 'synthetic-shared', userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  const principal = helper.describeAuthenticatedPrincipal(paired.token);
  if (!principal) throw new Error('Fixture pairing unavailable');
  const body = { admission: 'autonomous', channel: 'signal:owned-recipient', message: 'Synthetic local reminder' };
  const send = <T>(operation: (lifetime: DeliveryLifetime) => Promise<T>) => runNativeMutation({
    host, method: 'occasions.sweep.delivery', effect: 'send', body, invocation: {},
    context: { ...normalizeContext(principal), nativeExecutionAuthority: helper.createNativeExecutionAuthority(paired.token, principal.scopes) ?? undefined,
      isAuthorized: scopes => Boolean(helper.describeAuthenticatedPrincipal(paired.token)?.admin && scopes?.every(scope => principal.scopes.includes(scope))) },
    target: { channel: body.channel, message: body.message }, assertTargetCurrent() {},
    mutate: async (assertCurrent, _admission, withPublication) => operation({ signal: signal.signal, assertCurrent, withPublication }),
  });
  return { directory, config, host, pairing, paired, body, send, invalidations, humans: () => humans };
}

function sink() {
  const received: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received.push(await request.text()); return Response.json({ id: 'owned-receipt' });
  } }); cleanup.push(() => server.stop(true));
  return { received, url: `http://127.0.0.1:${server.port}` };
}
function bridge(f: ReturnType<typeof fixture>, url: string, secret: () => Promise<string>) {
  f.config.set('surfaces.signal.bridgeUrl', url);
  return new ChannelDeliveryRouter({ configManager: f.config,
    serviceRegistry: { resolveSecret: secret, get: () => undefined } as unknown as ServiceRegistry,
    artifactStore: {} as ArtifactStore, secretsManager: { get: async () => null, getGlobalHome: () => f.directory } });
}
const request = { target: { kind: 'surface' as const, surfaceKind: 'signal' as const, address: 'owned-recipient' },
  title: 'Synthetic reminder', body: 'Synthetic local reminder', jobId: 'owned-job', runId: 'owned-run', includeLinks: false };

test.each(['revoke', 'source', 'floor'] as const)('authentic send: %s during real credential preparation prevents every loopback POST', async kind => {
  const f = fixture(), local = sink(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const router = bridge(f, local.url, async () => { entered.resolve(); return release.promise; });
  const pending = f.send(lifetime => router.deliver({ ...request, ...lifetime }));
  await entered.promise;
  // A paired-owner revoke succeeds now: the router is not holding a publication lock through credentials.
  if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
  if (kind === 'source') f.body.message = 'Changed source';
  if (kind === 'floor') f.config.set('permissions.mode', 'plan');
  release.resolve('owned-token'); await expect(pending).rejects.toThrow();
  expect(local.received).toHaveLength(0); expect(f.humans()).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(1);
});

test('authentic native send holds paired ownership only through actual accepted loopback dispatch', async () => {
  const f = fixture(), local = sink(); let duringDispatch: unknown;
  const result = await f.send(lifetime => runDeliveryPublication(lifetime, async () => {
    try { f.pairing.revoke(f.paired.id); } catch (error) { duringDispatch = error; }
    return (await fetch(local.url, { method: 'POST', body: f.body.message })).json();
  }));
  expect(duringDispatch).toBeInstanceOf(Error); expect(result).toEqual({ id: 'owned-receipt' });
  expect(local.received).toEqual(['Synthetic local reminder']);
  expect(f.pairing.revoke(f.paired.id)).toBe(true);
});

test('an accepted loopback send stays truthful when the native keeper retires after dispatch', async () => {
  const f = fixture(), local = sink(); let retired: DeliveryLifetime | undefined;
  const result = await f.send(lifetime => { retired = lifetime; return runDeliveryPublication(lifetime, async () => {
    const response = await fetch(local.url, { method: 'POST', body: f.body.message });
    const receipt = await response.json();
    for (const invalidate of f.invalidations) invalidate();
    return receipt;
  }); });
  expect(result).toEqual({ id: 'owned-receipt' }); expect(local.received).toHaveLength(1);
  await expect(runDeliveryPublication(retired!, () => fetch(local.url, { method: 'POST' }))).rejects.toThrow();
  expect(local.received).toHaveLength(1);
});

test('publication cannot skip, replay, substitute a result or invoke a retired callback', async () => {
  let effects = 0, late: (() => Promise<unknown>) | undefined;
  const skipped = (async () => 'forged') as unknown as MutationPublication;
  await expect(runDeliveryPublication({ withPublication: skipped }, () => ++effects)).rejects.toThrow('did not finish');
  expect(effects).toBe(0);
  const substituted = (async (operation: (current: () => void) => unknown | Promise<unknown>) => {
    await operation(() => {}); await expect(operation(() => {})).rejects.toThrow('not current'); return 'forged';
  }) as unknown as MutationPublication;
  const result = await runDeliveryPublication({ withPublication: substituted }, () => ++effects);
  expect(result).toBe(1); expect(effects).toBe(1);
  const deferred = (async (operation: (current: () => void) => unknown | Promise<unknown>) => { late = async () => operation(() => {}); }) as unknown as MutationPublication;
  await expect(runDeliveryPublication({ withPublication: deferred }, () => ++effects)).rejects.toThrow();
  await expect(late!()).rejects.toThrow('not current'); expect(effects).toBe(1);
});

test('each pinned connection attempt re-enters publication after the previous failure', async () => {
  let attempts = 0, publications = 0;
  const mock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { attempts++; throw new Error('Owned refusal'); },
    { preconnect() {} })); cleanup.push(() => mock.mockRestore());
  await expect(pinnedFetch('http://owned.example.invalid/post', { method: 'POST' },
    [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }], 'opaque-url', undefined,
    async operation => { if (++publications === 2) throw new Error('Owned retired retry'); return operation(() => {}); })).rejects.toThrow('retired retry');
  expect(publications).toBe(2); expect(attempts).toBe(1);
});

test('native encrypted push prepares credentials outside publication and preserves a real accepted receipt', async () => {
  const f = fixture(), local = sink(), key = createECDH('prime256v1'); key.generateKeys();
  const store = new PushSubscriptionStore(join(f.directory, 'push.json'));
  const subscription = (await store.register({ principalId: 'synthetic-owner', endpoint: local.url,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }));
  const vapid = { async buildAuthorizationHeader() { return 'owned-authorization'; } } as unknown as VapidManager;
  const receipt = await f.send(lifetime => deliverToSubscription(subscription, { title: 'Synthetic', body: 'Owned push' }, { store, vapid,
    transport: async (url, init) => { const response = await fetch(url, { ...init, body: new Uint8Array(init.body) });
      for (const invalidate of f.invalidations) invalidate(); return { status: response.status }; } }, lifetime));
  expect(receipt.outcome).toBe('delivered'); expect(receipt.httpStatus).toBe(200); expect(local.received).toHaveLength(1);
  expect((await store.get(subscription.id))?.lastOutcome).toBe('delivered');
});

test('native encrypted push retirement during credential preparation sends nothing and does not penalize the endpoint', async () => {
  const f = fixture(), local = sink(), key = createECDH('prime256v1'); key.generateKeys();
  const store = new PushSubscriptionStore(join(f.directory, 'push.json'));
  const subscription = await store.register({ principalId: 'synthetic-owner', endpoint: local.url,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const vapid = { async buildAuthorizationHeader() { entered.resolve(); return release.promise; } } as unknown as VapidManager;
  const pending = f.send(lifetime => deliverToSubscription(subscription, { title: 'Synthetic', body: 'Owned push' }, { store, vapid }, lifetime));
  await entered.promise; expect(f.pairing.revoke(f.paired.id)).toBe(true); release.resolve('owned-authorization');
  await expect(pending).rejects.toThrow(); expect(local.received).toHaveLength(0);
  expect((await store.get(subscription.id))?.lastOutcome).toBeUndefined();
});

async function smtpFixture(auth: (socket: Socket) => void, observe: (line: string) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8');
    socket.write('220 owned.smtp.test ESMTP\r\n');
    let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n'); if (end === -1) break;
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); observe(line);
        if (data) { if (line === '.') { data = false; socket.write('250 Message accepted\r\n'); } continue; }
        if (line.startsWith('EHLO')) socket.write('250-owned.smtp.test\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH')) auth(socket);
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 OK\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 Send body\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('SMTP fixture unavailable');
  const socket = await new Promise<Socket>(resolve => { const client = connect({ host: '127.0.0.1', port: address.port }, () => resolve(client)); });
  return new SmtpClient({ socket, hostname: 'owned.smtp.test', username: 'synthetic', password: 'owned-secret' });
}

test('native SMTP authentication preparation permits revocation before any message transaction', async () => {
  const f = fixture(), entered = Promise.withResolvers<Socket>(), lines: string[] = [];
  const client = await smtpFixture(socket => entered.resolve(socket), line => lines.push(line));
  const pending = f.send(lifetime => client.sendMail({ from: 'sender@owned.test', to: 'receiver@owned.test',
    subject: 'Synthetic message', body: 'Owned local body', ...lifetime }));
  const socket = await entered.promise; expect(f.pairing.revoke(f.paired.id)).toBe(true);
  socket.write('235 Authenticated\r\n'); await expect(pending).rejects.toThrow();
  expect(lines.some(line => line.startsWith('AUTH'))).toBe(true);
  expect(lines.some(line => line.startsWith('MAIL') || line === 'DATA' || line === 'Owned local body')).toBe(false);
});

test('native SMTP locks only the actual message transaction and preserves the server acceptance', async () => {
  const f = fixture(); let held = false;
  const lines: string[] = [];
  const client = await smtpFixture(socket => { expect(held).toBe(false); socket.write('235 Authenticated\r\n'); }, line => {
    lines.push(line); if (line.startsWith('MAIL') || line.startsWith('RCPT') || line === 'DATA' || line === 'Owned local body') expect(held).toBe(true);
  });
  const result = await f.send(lifetime => client.sendMail({ from: 'sender@owned.test', to: 'receiver@owned.test',
    subject: 'Synthetic message', body: 'Owned local body', ...lifetime, withPublication: async operation => {
      if (!lifetime.withPublication) throw new Error('Authentic publication missing');
      return lifetime.withPublication(async current => {
        held = true;
        try { const receipt = await operation(current); for (const invalidate of f.invalidations) invalidate(); return receipt; }
        finally { held = false; }
      });
    } }));
  expect(lines).toContain('Owned local body'); expect(lines).toContain(`Message-ID: ${result.messageId}`);
  expect(Number.isFinite(Date.parse(result.sentAt))).toBe(true); expect(held).toBe(false);
});
