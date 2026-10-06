import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import type { NativeWorkExecutionIdentity } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { agentHostPairingStorePath, type AgentHostPairingSecret } from '../../runtime/connected-host-pairing-store.ts';
import { readConnectedHostOperatorToken } from '../../runtime/connected-host-auth.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { readConnectedHostReadiness } from '../../runtime/connected-host-readiness.ts';
import { createNativeWorkSubmissionBinding, nativeSubmissionIdentity } from '../../runtime/native-work-submission-host.ts';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';
import { createNativeLedgerBinding, createNativeWorkLedgerView } from '../../runtime/native-work-ledger-host.ts';
import { executeNativeHeadless } from '../../cli/native-headless.ts';

const envNames = ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] as const;
const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const homes: string[] = [];
beforeEach(() => { for (const key of envNames) delete process.env[key]; });
afterEach(() => {
  for (const key of envNames) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const secret: AgentHostPairingSecret = { token: 'synthetic-identical-token', tokenId: 'selected-owner', name: 'Synthetic Agent', createdAt: 1 };
function fixture(baseUrl = 'http://127.0.0.1:3421') {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'agent-selection-')); homes.push(homeDirectory);
  const pairingPath = agentHostPairingStorePath(homeDirectory);
  const globalPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(dirname(pairingPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(globalPath), { recursive: true, mode: 0o700 });
  writeFileSync(globalPath, JSON.stringify({ token: secret.token }), { mode: 0o600 });
  const pair = (record: AgentHostPairingSecret = secret) => writeFileSync(pairingPath, JSON.stringify({ version: 1, records: [{ host: new URL(baseUrl).origin, pairing: { status: 'paired', ...record } }] }), { mode: 0o600 });
  pair();
  const config = { 'controlPlane.host': new URL(baseUrl).hostname, 'controlPlane.port': Number(new URL(baseUrl).port || 80), 'daemon.connectedHost.enabled': true };
  const configManager = { get: (key: string) => config[key as keyof typeof config] } as ConfigManager;
  const options = { configManager, homeDirectory };
  const resolve = () => {
    const connection = resolveConnectedHostConnection(options);
    if ('reason' in connection) throw new Error(connection.reason);
    return { ...connection, workspace: homeDirectory, journalPath: join(homeDirectory, 'native-intake.json') };
  };
  return { ...options, baseUrl, pairingPath, globalPath, pair, resolve };
}
const auth = (principalId: string) => ({ authenticated: true, authMode: 'shared-token', tokenPresent: true,
  authorizationHeaderPresent: true, sessionCookiePresent: false, principalId, principalKind: 'token', admin: true,
  scopes: ['read:work-ledger', 'write:work-ledger', 'write:sessions'], roles: [] });
function hostFixture() {
  const requests: string[] = []; const captures: NativeConversationIntakeCaptureRequest[] = [];
  let principal = 'pairing:selected-owner'; let scopes: string[] | undefined;
  let onAuth: () => void | Promise<void> = () => {}; let onProject = () => {};
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${secret.token}`);
    const path = new URL(request.url).pathname; requests.push(path);
    if (path === '/api/control-plane/auth') { const value = { ...auth(principal), ...(scopes ? { scopes } : {}) }; await onAuth(); return Response.json(value); }
    if (path === '/api/work-ledger/project') { onProject(); return Response.json({ projectId: 'p' }); }
    if (path === '/api/work-ledger/intake/capture') {
      const command = await request.json() as NativeConversationIntakeCaptureRequest; captures.push(command);
      return Response.json({ kind: 'captured', projectId: 'p', requestId: command.requestId,
        sourceRef: { version: 1, inputId: command.inputId, sourceId: 'source', sourceRevision: 'r1', sessionId: 'session' } });
    }
    if (path === '/api/work-ledger/intake/admit') {
      const command = captures.at(-1)!;
      return Response.json({ kind: 'refused', reason: 'semantic', projectId: 'p', requestId: command.requestId,
        sourceRef: { version: 1, inputId: command.inputId, sourceId: 'source', sourceRevision: 'r1', sessionId: 'session' } });
    }
    if (path.startsWith('/api/work-ledger/execution/')) {
      const { projectId, ...target } = await request.json() as NativeWorkExecutionIdentity & { projectId: string };
      return Response.json({ kind: 'pending-intent', projectId, ...target, currentRevision: target.expectedRevision,
        currentAttempt: true, stale: false, state: 'admitting', recovery: 'pending' });
    }
    return Response.json({ error: 'Unexpected synthetic route' }, { status: 500 });
  } });
  const f = fixture(server.url.origin);
  return { ...f, requests, captures, setPrincipal(value: string) { principal = value; },
    setScopes(value: string[]) { scopes = value; },
    onAuth(callback: () => void | Promise<void>) { onAuth = callback; }, onProject(callback: () => void) { onProject = callback; }, close() { server.stop(true); } };
}
const capture = { requestId: 'request', inputId: 'input', text: 'Original synthetic source', unsupportedSources: [] };
const submission = { requestId: 'request', inputId: 'input', expectedRevision: 0, goal: 'Synthetic goal', criteria: ['Synthetic criterion'] };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('Agent selected credential identity', () => {
  test('binds the canonical endpoint, home, selected source and full private record without exposing its contents', () => {
    const f = fixture('http://example.invalid'); const selected = f.resolve();
    expect(selected.expectedPrincipalId).toBe('pairing:selected-owner'); expect(selected.selectionIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.selectionIdentity).not.toContain(secret.token); expect(selected.selectionIdentity).not.toContain(secret.name);
    expect(readConnectedHostOperatorToken(f.homeDirectory, 'HTTP://EXAMPLE.INVALID:80/').selectionIdentity).toBe(selected.selectionIdentity);
    expect(readConnectedHostOperatorToken(f.homeDirectory, 'http://different.invalid').selectionIdentity).not.toBe(selected.selectionIdentity);
    expect(fixture('http://example.invalid').resolve().selectionIdentity).not.toBe(selected.selectionIdentity);
    for (const update of [{ tokenId: 'another-owner' }, { name: 'Renamed Agent' }, { createdAt: 2 }, { token: 'synthetic-replaced-token' }]) {
      f.pair({ ...secret, ...update }); const next = f.resolve();
      expect(next.selectionIdentity).not.toBe(selected.selectionIdentity);
      expect(nativeSubmissionIdentity(next, 'p')).not.toBe(nativeSubmissionIdentity(selected, 'p'));
    }
    f.pair();
    const file = JSON.parse(readFileSync(f.pairingPath, 'utf8'));
    file.records.push({ host: 'https://unselected.invalid', pairing: { status: 'paired', ...secret, name: 'Unselected record' } });
    writeFileSync(f.pairingPath, JSON.stringify(file));
    expect(f.resolve().selectionIdentity).toBe(selected.selectionIdentity);
  });

  test('preserves env > legacy env > exact-host private pairing > global precedence even for identical token bytes', () => {
    const f = fixture(); const privateSelection = f.resolve();
    process.env.GOODVIBES_DAEMON_TOKEN = secret.token; const daemon = f.resolve();
    process.env.GOODVIBES_CONNECTED_HOST_TOKEN = ` ${secret.token} `; const connected = f.resolve();
    expect(daemon.token).toBe(secret.token); expect(connected.token).toBe(secret.token);
    expect(connected.expectedPrincipalId).toBeUndefined(); expect(daemon.expectedPrincipalId).toBeUndefined();
    expect(new Set([privateSelection.selectionIdentity, daemon.selectionIdentity, connected.selectionIdentity]).size).toBe(3);
    f.pair({ ...secret, name: 'Shadowed replacement' }); expect(f.resolve().selectionIdentity).toBe(connected.selectionIdentity);
    delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; expect(f.resolve().selectionIdentity).toBe(daemon.selectionIdentity);
    delete process.env.GOODVIBES_DAEMON_TOKEN; f.pair(); expect(f.resolve().selectionIdentity).toBe(privateSelection.selectionIdentity);
    rmSync(f.pairingPath); const global = f.resolve();
    expect(global.token).toBe(privateSelection.token); expect(global.expectedPrincipalId).toBeUndefined();
    expect(global.selectionIdentity).not.toBe(privateSelection.selectionIdentity);
    process.env.GOODVIBES_DAEMON_TOKEN = secret.token;
    expect(f.resolve().selectionIdentity).not.toBe(global.selectionIdentity);
  });

  for (const change of ['metadata', 'removal', 'environment-source'] as const) {
    test(`${change} revokes ledger selection and observing a swap back cannot restore it`, async () => {
      const f = fixture(); let disposed = 0;
      const view = createNativeWorkLedgerView(f.resolve, () => {}, () => ({ available: true, client: {
        projectId: 'p', readSnapshot: async () => ({ projectId: 'p', cursor: 0, revision: 0, works: [] }),
        history: async () => [], subscribe: () => () => {}, dispose() { disposed++; },
      } }));
      try {
        view.selectProject('p'); view.open(); await flush(); expect(view.state.status).toBe('ready');
        if (change === 'metadata') f.pair({ ...secret, createdAt: 2 });
        if (change === 'removal') rmSync(f.pairingPath);
        if (change === 'environment-source') process.env.GOODVIBES_CONNECTED_HOST_TOKEN = secret.token;
        view.sync(); expect(view.state.status).toBe('unavailable'); expect(disposed).toBe(1);
        f.pair(); delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; view.sync();
        expect(view.state.status).toBe('unavailable');
      } finally { view.close(); }
    });
  }
});

describe('private paired authority fences', () => {
  for (const type of ['intake', 'submission'] as const) {
    test(`${type} rejects another live paired principal at admission and again immediately before mutation`, async () => {
      const f = hostFixture(); const binding = type === 'intake'
        ? createNativeConversationIntakeBinding(f.resolve(), 'p') : createNativeWorkSubmissionBinding(f.resolve(), 'p');
      try {
        f.setPrincipal('pairing:other-owner');
        await expect(binding.readPrincipal(new AbortController().signal)).rejects.toThrow();
        f.setPrincipal('pairing:selected-owner');
        expect(await binding.readPrincipal(new AbortController().signal)).toBe('pairing:selected-owner');
        f.setPrincipal('pairing:other-owner');
        if ('capture' in binding.client) await expect(binding.client.capture(capture)).rejects.toThrow();
        else await expect(binding.client.submit(submission)).rejects.toThrow();
        expect(f.requests.every(path => path === '/api/control-plane/auth')).toBe(true);
        expect(f.captures).toHaveLength(0); expect(existsSync(f.resolve().journalPath)).toBe(false);
      } finally { binding.dispose(); f.close(); }
    });

    test(`${type} drops a private call if its selection changes during fresh auth`, async () => {
      const f = hostFixture(); const selected = f.resolve();
      const current = () => f.resolve().selectionIdentity === selected.selectionIdentity;
      const binding = type === 'intake' ? createNativeConversationIntakeBinding(selected, 'p', current)
        : createNativeWorkSubmissionBinding(selected, 'p', current);
      try {
        f.onAuth(() => f.pair({ ...secret, name: 'Replaced while authenticating' }));
        if ('capture' in binding.client) await expect(binding.client.capture(capture)).rejects.toThrow();
        else await expect(binding.client.submit(submission)).rejects.toThrow();
        expect(f.requests).toEqual(['/api/control-plane/auth']);
      } finally { binding.dispose(); f.close(); }
    });
  }

  test('readiness requires the private principal but environment overrides do not inherit private authority', async () => {
    const f = hostFixture();
    try {
      expect((await readConnectedHostReadiness(f)).status).toBe('ready');
      f.setPrincipal('pairing:other-owner'); expect((await readConnectedHostReadiness(f)).status).toBe('unsupported-principal');
      process.env.GOODVIBES_CONNECTED_HOST_TOKEN = secret.token;
      expect((await readConnectedHostReadiness(f)).status).toBe('ready');
    } finally { f.close(); }
  });

  for (const change of ['metadata', 'removal', 'environment-source'] as const) {
    test(`readiness discards an auth response after same-token ${change}`, async () => {
      const f = hostFixture();
      try {
        f.onAuth(() => {
          if (change === 'metadata') f.pair({ ...secret, name: 'Replaced during auth' });
          if (change === 'removal') rmSync(f.pairingPath);
          if (change === 'environment-source') process.env.GOODVIBES_DAEMON_TOKEN = secret.token;
        });
        expect((await readConnectedHostReadiness(f)).status).toBe('changed');
      } finally { f.close(); }
    });
  }
});

describe('native headless selected identity propagation', () => {
  for (const mode of ['matching', 'wrong-principal', 'metadata', 'removal', 'environment-source'] as const) {
    test(`headless ${mode} retains the full connection selection through discovery and intake binding`, async () => {
      const f = hostFixture(); let turns = 0;
      try {
        if (mode === 'wrong-principal') f.setPrincipal('pairing:other-owner');
        f.onProject(() => {
          if (mode === 'metadata') f.pair({ ...secret, createdAt: 2 });
          if (mode === 'removal') rmSync(f.pairingPath);
          if (mode === 'environment-source') process.env.GOODVIBES_CONNECTED_HOST_TOKEN = secret.token;
        });
        const result = await executeNativeHeadless({ mode: 'submit', prompt: capture.text, resolveHost: f.resolve,
          signal: new AbortController().signal, runTurn: async () => { turns++; throw new Error('Synthetic refusal must never run a turn'); } });
        expect(turns).toBe(0);
        if (mode === 'matching') {
          expect(result.native?.result?.kind).toBe('refused'); expect(f.captures).toHaveLength(1);
          expect(f.captures[0]?.text).toBe(capture.text);
        } else {
          expect(result.native?.status).toBe('unavailable'); expect(f.captures).toHaveLength(0);
          expect(existsSync(f.resolve().journalPath)).toBe(false);
        }
      } finally { f.close(); }
    });
  }
});

describe('explicit native ledger execution selected identity', () => {
  const target: NativeWorkExecutionIdentity = { workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } };
  for (const authority of ['matching', 'wildcard', 'wrong-principal', 'missing-read', 'missing-fleet'] as const) {
    test(`${authority} checks exact private execution authority for start/status/cancel/resume`, async () => {
      const f = hostFixture();
      f.setScopes(authority === 'wildcard' ? ['*'] : ['read:work-ledger', 'write:fleet'].filter(scope =>
        !(authority === 'missing-read' && scope === 'read:work-ledger') && !(authority === 'missing-fleet' && scope === 'write:fleet')));
      if (authority === 'wrong-principal') f.setPrincipal('pairing:other-owner');
      const binding = createNativeLedgerBinding(f.resolve(), 'p', () => {});
      if (!binding.available || !binding.execution) throw new Error('Synthetic binding unavailable');
      try {
        for (const action of ['start', 'status', 'cancel', 'resume'] as const) {
          if (authority === 'matching' || authority === 'wildcard') {
            expect((await binding.execution[action](target)).kind).toBe('pending-intent');
            expect(f.requests.slice(-2)).toEqual(['/api/control-plane/auth', `/api/work-ledger/execution/${action}`]);
          } else await expect(binding.execution[action](target)).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY' });
        }
        if (authority !== 'matching' && authority !== 'wildcard') expect(f.requests).toEqual(Array(4).fill('/api/control-plane/auth'));
      } finally { binding.execution.dispose(); binding.client.dispose(); f.close(); }
    });
  }

  for (const change of ['metadata', 'removal', 'environment-source', 'close-reopen'] as const) {
    test(`held execution auth cannot dispatch after ${change}, even before a periodic selection sync`, async () => {
      const f = hostFixture(); f.setScopes(['read:work-ledger', 'write:fleet']);
      let entered!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      f.onAuth(async () => { entered(); await held; });
      const view = createNativeWorkLedgerView(f.resolve, () => {}, (host, project, unavailable, current) => {
        const binding = createNativeLedgerBinding(host, project, unavailable, current);
        if (!binding.available) return binding;
        // Keep real execution transport and the open() selection/epoch callback;
        // inject only the read-only projection to avoid unrelated event streams.
        return { ...binding, client: { projectId: project,
          readSnapshot: async () => ({ projectId: project, cursor: 0, revision: 0, works: [{
            work: { source: null, id: 'work', title: 'Synthetic work', goal: 'Synthetic goal', criteria: ['Synthetic criterion'], revision: 1,
              criteriaRevision: 1, reportedState: 'in_progress' as const, currentAttemptId: 'attempt', createdAt: 1, updatedAt: 1 },
            attempt: { id: 'attempt', workId: 'work', predecessorId: null, ownerId: 'pairing:selected-owner', revision: 1,
              state: 'active' as const, report: null, blocker: null, createdAt: 1, updatedAt: 1 },
            verification: { state: 'unverified' as const, reason: 'Synthetic fixture', evidence: null }, attention: [],
          }] }), history: async () => [], subscribe: () => () => {}, dispose: () => binding.client.dispose(),
        } };
      });
      try {
        view.selectProject('p'); view.open(); await flush(); expect(view.state.status).toBe('ready');
        const pending = view.execute!('start', 'work'); await arrived;
        if (change === 'metadata') f.pair({ ...secret, name: 'Replaced during execution auth' });
        if (change === 'removal') rmSync(f.pairingPath);
        if (change === 'environment-source') process.env.GOODVIBES_CONNECTED_HOST_TOKEN = secret.token;
        if (change === 'close-reopen') { view.close(); view.selectProject('p'); view.open(); }
        release(); expect(await pending).toBeUndefined();
        expect(f.requests).toEqual(['/api/control-plane/auth']);
      } finally { release(); view.close(); f.close(); }
    });
  }
});
