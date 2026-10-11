import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
/** Compiled TUI, real owner PTY, and owned production pairing/native-capture handlers. */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore, getProviderModelsCachePath } from '@goodvibes-jev/engine/sdk/platform/providers';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { beginTuiHostPairing, completeTuiHostPairing, tuiHostPairingStorePath, readTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { isolatedEnv, makeHome, resolveBinary, startHomeDaemonServer, startStubModel, waitFor } from './harness.ts';

const AUTH = '/api/control-plane/auth';
const MIGRATE = '/api/control-plane/methods/pairing.tokens.migrate/invoke';
const PREVIEW = '/host pair --bootstrap-shared';
const APPLY = `${PREVIEW} --apply`;
// Background shell activity is denied locally, never forwarded as mutations.
const BACKGROUND_ROUTES = new Set([
  '/api/control-plane/methods/fleet.snapshot/invoke',
  '/api/control-plane/methods/rewind.conversation.host.register/invoke',
  '/api/sessions/register',
  '/api/control-plane/methods/approvals.list/invoke',
  '/api/control-plane/methods/sessions.hosted.list/invoke',
  '/api/memory/records/search',
  '/api/control-plane/methods/sessions.inputs.list/invoke',
]);
type Hold = 'preview' | 'revalidation' | 'migration' | 'verification';
type Cancel = 'Ctrl-C' | 'Escape' | 'Ctrl-D' | 'exit' | 'replacement' | 'SIGTERM';
import { TerminalFrame } from '../helpers/terminal-frame.ts';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(nativeCaptureFailure = false) {
  const model = startStubModel(() => ({ text: 'Unexpected pairing model request' }));
  const home = await makeHome(model).catch(error => { model.stop(); throw error; });
  mkdirSync(join(home.root, 'tmp'), { recursive: true });
  const tuiDir = join(home.home, '.goodvibes/tui');
  const daemonHome = join(home.home, '.goodvibes/daemon');
  const networkViolations = join(home.root, 'network-violations.log');
  const guard = resolve(import.meta.dir, '../../../../../packages/engine/scripts/test-network-preload.ts');
  writeFileSync(join(home.workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`);
  const now = Date.now();
  writeFileSync(join(tuiDir, 'onboarding-checked.json'), JSON.stringify({ version: 1, checkedAt: now, updatedAt: now, source: 'e2e' }));
  const configManager = new TuiConfigManager({ configDir: tuiDir, homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
  seedProviderMetadataCacheFixture({ configManager, homeDirectory: home.home, workingDirectory: home.workspace });
  const models = getProviderModelsCachePath(configManager.getControlPlaneConfigDir(), 'openai');
  mkdirSync(dirname(models), { recursive: true });
  writeFileSync(models, JSON.stringify({ version: 1, fetchedAt: now, ttlMs: 86_400_000, models: [] }));
  const daemonRoot = join(home.root, 'pairing-host');
  const daemon = await startDaemonFixture({ root: daemonRoot, token: 'synthetic-tui-interactive-pairing-bootstrap', hostSessions: false,
    configure(configManager) {
      const homeDirectory = join(daemonRoot, 'home');
      seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory: join(daemonRoot, 'workspace') });
      const models = getProviderModelsCachePath(configManager.getControlPlaneConfigDir(), 'openai');
      mkdirSync(dirname(models), { recursive: true });
      writeFileSync(models, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: [] }));
      for (const dir of [join(homeDirectory, '.goodvibes'), join(homeDirectory, '.goodvibes/tui')]) {
        const cache = new BenchmarkStore({ dir }).getCachePath();
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
      }
    },
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  }).catch(error => { model.stop(); rmSync(home.root, { recursive: true, force: true }); throw error; });
  let stopProxy: (() => Promise<void>) | undefined;
  try {
    const legacyPath = join(daemonHome, 'operator-tokens.json');
    writeFileSync(legacyPath, JSON.stringify({ token: daemon.token, peerId: 'synthetic-tui-owner', createdAt: Date.now() }), { mode: 0o600 });
    const gate = deferred();
    const requests = new AbortController();
    let hold: Hold | undefined;
    let pairingAuthCalls = 0;
    let migrations = 0;
    let completedAuth = 0;
    let held = false;
    const authTokens: Array<string | null> = [];
    const unexpectedMutations: string[] = [];
    const nativeCaptures: Array<{ status: number; body: unknown }> = [];
    const nativeRoutes = new Set([WEBUI_METHOD_ROUTES['workLedger.project'].path,
      WEBUI_METHOD_ROUTES['workLedger.intake.capture'].path, WEBUI_METHOD_ROUTES['workLedger.intake.get'].path]);
    // Configure both legacy discovery and the explicit origin from the bound
    // front door, never by trying to reclaim makeHome's released port probe.
    const proxy = await startHomeDaemonServer(home, async request => {
      const url = new URL(request.url);
      const path = url.pathname;
      // Startup discovery/event routes are deliberately absent: this owned
      // front door exposes real pairing handlers and, only for the workstream
      // cases, native project/capture/get. No admission, execution, revoke,
      // delete or cleanup mutation can pass.
      if (request.method !== 'GET' && request.method !== 'HEAD' && path !== MIGRATE && !(nativeCaptureFailure && nativeRoutes.has(path)) && !BACKGROUND_ROUTES.has(path) && !/^\/api\/sessions\/[^/]+\/close$/.test(path)) {
        unexpectedMutations.push(`${request.method} ${path}`);
        return new Response('Unexpected test mutation', { status: 403 });
      }
      if (path !== AUTH && path !== MIGRATE && !(nativeCaptureFailure && nativeRoutes.has(path))) return new Response('Not part of the pairing fixture', { status: 404 });
      const authOrdinal = path === AUTH ? ++pairingAuthCalls : 0;
      if (path === AUTH) {
        authTokens.push(request.headers.get('authorization'));
      }
      if (path === MIGRATE) migrations++;
      const requestBody = request.method === 'POST' ? await request.arrayBuffer() : undefined;
      const response = await fetch(`${daemon.baseUrl}${path}${url.search}`, {
        method: request.method, headers: request.headers,
        body: requestBody,
        redirect: 'error', signal: AbortSignal.any([requests.signal, request.signal]),
      });
      // Hold only after the production handler has finished. A withheld POST
      // reply therefore means the real daemon has already issued one secret.
      const body = await response.arrayBuffer();
      if (nativeCaptureFailure && path === WEBUI_METHOD_ROUTES['workLedger.intake.capture'].path) {
        nativeCaptures.push({ status: response.status, body: JSON.parse(new TextDecoder().decode(requestBody)) });
        // Lose only the acknowledgement, after the real production capture
        // handler ran. No semantic endpoint or alternate source route exists.
        return new Response('Owned fixture lost capture acknowledgement', { status: 503 });
      }
      if (!held && ((hold === 'preview' && path === AUTH && authOrdinal === 1)
        || (hold === 'revalidation' && path === AUTH && authOrdinal === 2)
        || (hold === 'migration' && path === MIGRATE)
        || (hold === 'verification' && path === AUTH && request.headers.get('authorization') !== `Bearer ${daemon.token}`))) {
        held = true;
        await gate.promise;
      }
      if (path === AUTH) completedAuth++;
      return new Response(body, { status: response.status, headers: response.headers });
    });
    stopProxy = async () => { requests.abort(); gate.release(); await proxy.stop(true); };
    const host = proxy.url.origin;
    const sharedFiles = [legacyPath, join(daemonHome, 'settings.json')].map(path => ({ path, bytes: readFileSync(path) }));
    if (nativeCaptureFailure) {
      const paths = daemon.services.shellPaths;
      const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(paths), fallbackReadPath: legacyWorkspaceRegisterPath(paths),
        homeDir: daemon.homeDirectory, daemonStateDir: paths.resolveUserPath() });
      await scopes.add(daemon.workingDirectory);
      const paired = daemon.services.pairingTokens.mint({ name: 'Owned workstream PTY fixture' });
      const attempt = { attemptId: 'owned-workstream-pairing', name: paired.name, startedAt: Date.now() };
      expect((await beginTuiHostPairing(home.home, host, attempt)).status).toBe('begun');
      expect((await completeTuiHostPairing(home.home, host, attempt.attemptId, {
        token: paired.token, tokenId: paired.id, name: paired.name, createdAt: paired.createdAt,
      })).status).toBe('paired');
    }
    const env = isolatedEnv(home, { PATH: '/usr/bin:/bin', GOODVIBES_TEST_NETWORK_VIOLATIONS: networkViolations });
    const argv = [resolveBinary(), '--config', `controlPlane.publicBaseUrl=${host}`, '--config', 'daemon.enabled=true'];
    const sessions: Array<{ stop(): Promise<void>; assertOutput(): void }> = [];
    function spawn(cols = 180, rows = 50, paletteReplies = true) {
      const frame = new TerminalFrame(cols, rows);
      const phrasesSeen = new Set<string>();
      const commandPhrases = new Map<number, Set<string>>();
      let output = '';
      let overflow = false;
      let stopped = false;
      const decoder = new TextDecoder();
      const child = Bun.spawn(argv, {
        cwd: home.workspace, env,
        terminal: { cols, rows, data: (_terminal, bytes) => {
          const chunk = decoder.decode(bytes, { stream: true });
          output += chunk; frame.write(chunk, bytes => { if (paletteReplies) _terminal.write(bytes); });
          for (const match of frame.text().matchAll(/Type (PAIR [0-9a-f]{12}) to create/g)) phrasesSeen.add(match[1]!);
          if (output.length > 2_000_000) { overflow = true; output = output.slice(-2_000_000); }
        } },
      });
      const session = {
        child,
        output: () => output,
        phrases: () => [...phrasesSeen],
        screen: () => frame.text(),
        resize(cols: number, rows: number) { frame.resize(cols, rows); child.terminal!.resize(cols, rows); },
        text: (since = 0) => stripVTControlCharacters(output.slice(since)),
        mark: () => output.length,
        write: (text: string) => child.terminal!.write(text),
        command(text: string) { const since = output.length; commandPhrases.set(since, new Set(phrasesSeen)); child.terminal!.write(`${text}\r`); return since; },
        async find(what: string, predicate: (text: string) => boolean, since = 0) {
          try { return await waitFor(what, () => output.length > since && predicate(session.screen()) && session.screen(), 10_000, 15); }
          catch (error) { throw new Error(`${String(error)}\n--- terminal ---\n${session.screen()}`); }
        },
        async prompt(since = 0) {
          const unseen = (text: string) => Array.from(text.matchAll(/Type (PAIR [0-9a-f]{12}) to create/g)).map(match => match[1]!).find(phrase => !commandPhrases.get(since)?.has(phrase));
          const text = await session.find('fresh owner pairing confirmation', text => unseen(text) !== undefined, since);
          return unseen(text)!;
        },
        async exit() {
          await waitFor('interactive shell exit', () => child.exitCode !== null || child.signalCode !== null, 10_000, 15);
          return await child.exited;
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await child.exited;
          child.terminal?.close();
        },
        assertOutput() {
          expect(overflow).toBe(false);
          expect(output).not.toContain(daemon.token);
          expect(output).not.toContain('gvp_');
          expect(frame.text()).not.toContain(daemon.token);
          expect(frame.text()).not.toContain('gvp_');
        },
      };
      sessions.push(session);
      return session;
    }
    async function launch(cols = 180, rows = 50, paletteReplies = true) {
      const session = spawn(cols, rows, paletteReplies);
      await session.find('interactive input', text => text.includes('Ask anything, or type / for commands'));
      // First paint can precede stdin subscription. Prove the real composer is
      // listening with an unsent, idempotent echo, then clear it before commands.
      await waitFor('live owner composer', () => {
        if (session.screen().includes('┃  x')) return true;
        session.write('\x15x');
        return false;
      }, 10_000, 30);
      const cleared = session.mark(); session.write('\x15');
      await session.find('empty live owner composer', text => text.includes('Ask anything, or type / for commands') && !text.includes('┃  x'), cleared);
      return session;
    }
    return { home, host, daemon, launch, nativeCaptures, release: gate.release,
      arm(value: Hold) { hold = value; pairingAuthCalls = 0; },
      held: () => held,
      migrations: () => migrations,
      completedAuth: () => completedAuth,
      authTokens,
      async stop() {
        try {
          const stopped = await Promise.allSettled(sessions.map(session => session.stop()));
          gate.release(); requests.abort();
          const servers = await Promise.allSettled([proxy.stop(true), daemon.stop()]);
          const failed = [...stopped, ...servers].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Owned pairing fixture cleanup failed');
          for (const session of sessions) session.assertOutput();
          for (const file of sharedFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
          expect(unexpectedMutations).toEqual([]);
          expect(model.requests).toEqual([]);
          expect(existsSync(networkViolations) ? readFileSync(networkViolations, 'utf8') : '').toBe('');
        } finally { model.stop(); rmSync(home.root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await stopProxy?.(); } finally { try { await daemon.stop(); } finally { model.stop(); rmSync(home.root, { recursive: true, force: true }); } }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<Fixture['launch']>>;

async function cancel(session: Session, action: Cancel, f?: Fixture) {
  const since = session.mark();
  if (action === 'exit') { session.command('/quit'); await session.exit(); return; }
  if (action === 'SIGTERM') { session.child.kill('SIGTERM'); await session.exit(); return; }
  if (action === 'replacement') {
    const completedAuth = f!.completedAuth();
    const unknown = readTuiHostPairing(f!.home.home, f!.host).status === 'unknown';
    session.command(PREVIEW);
    await session.find('replacement cancels the earlier operation', text => /cancelled|interrupted|TUI host pairing: (unknown|paired-unverified)/i.test(text), since);
    if (!unknown) await waitFor('fresh replacement authority response', () => f!.completedAuth() > completedAuth, 10_000, 15);
    await session.find('replacement pairing result', text => /TUI host pairing: (preview|unknown|already-paired)/.test(text), since);
    return;
  }
  session.write(action === 'Ctrl-C' ? '\x03' : action === 'Escape' ? '\x1b' : '\x04');
  await session.find('pairing interruption result', text => /cancelled|interrupted|TUI host pairing: (unknown|paired-unverified)/i.test(text), since);
  expect(session.child.exitCode).toBeNull();
}

async function confirm(session: Session) {
  const since = session.command(APPLY);
  const phrase = await session.prompt(since);
  const answer = session.mark();
  session.write(`${phrase}\r`);
  return answer;
}

describe('compiled interactive TUI owner pairing', () => {
  test('preview is read-only; exact composer confirmation pairs once and survives a fresh shell', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      let since = session.command(PREVIEW);
      await session.find('read-only pairing preview', text => text.includes('TUI host pairing: preview'), since);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
      since = session.command(APPLY);
      const phrase = await session.prompt(since);
      const preview = session.screen().replace(/[┃│]/g, '').replace(/\s+/g, ' ');
      expect(preview).toContain(f.host);
      expect(preview).toContain('persistent administrative');
      expect(preview).toContain('Device name: GoodVibes TUI');
      expect(preview).toContain('existing daemon-global operator token');
      expect(f.migrations()).toBe(0);
      const answer = session.mark();
      session.write(`${phrase}\r`);
      await session.find('verified pairing result', text => /TUI host pairing: paired\s/.test(text), answer);
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('paired');
      const store = tuiHostPairingStorePath(f.home.home);
      expect(statSync(store).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(store)).mode & 0o777).toBe(0o700);
      await session.stop();
      const restart = await f.launch();
      const restartSince = restart.command(APPLY);
      await restart.find('saved pairing is not reminted', text => text.includes('TUI host pairing: already-paired'), restartSince);
      expect(f.migrations()).toBe(1);
    } finally { await f.stop(); }
  }, 60_000);

  test('bootstrap is explicit; unsupported inline approvals cannot mint a credential', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      let since = session.command('/host pair --apply');
      await session.find('explicit bootstrap required', text => text.includes('TUI host pairing: blocked'), since);
      expect(f.authTokens).toHaveLength(0);
      for (const extra of ['--yes', '--confirm PAIR-queued', '--apply']) {
        since = session.command(`${APPLY} ${extra}`);
        await session.find('unsupported inline approval refused', text => text.includes('Usage: /host pair'), since);
      }
      expect(f.authTokens).toHaveLength(0);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
    } finally { await f.stop(); }
  }, 45_000);

  test('a stale phrase cannot authorize a fresh confirmation', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      const stale = await session.prompt(session.command(APPLY));
      await cancel(session, 'Escape');
      const fresh = await session.prompt(session.command(APPLY));
      expect(fresh).not.toBe(stale);
      const since = session.mark(); session.write(`${stale}\r`);
      await session.find('stale confirmation refused', text => text.includes('TUI host pairing: cancelled'), since);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
      const answer = await confirm(session);
      await session.find('a newly typed fresh answer succeeds', text => /TUI host pairing: paired\s/.test(text), answer);
      expect(f.migrations()).toBe(1);
    } finally { await f.stop(); }
  }, 45_000);

  test('a command and queued answer in one PTY burst cannot confirm an unseen preview', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      const stale = await session.prompt(session.command(APPLY));
      await cancel(session, 'Escape');
      f.arm('preview');
      // Deliberately one terminal write, unlike the valid post-paint response.
      const since = session.command(`${APPLY}\r${stale}`);
      await waitFor('held queued-answer preview', f.held, 10_000, 15);
      expect(f.migrations()).toBe(0);
      f.release();
      const fresh = await session.prompt(since);
      expect(fresh).not.toBe(stale);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
      // Force another frame so an old accumulated prompt cannot satisfy this.
      const resized = session.mark(); session.resize(181, 50);
      await session.find('fresh confirmation still awaits new owner input', text => text.includes(fresh) && text.includes('Ask anything, or type / for commands'), resized);
      expect(f.migrations()).toBe(0);
      const answer = session.mark(); session.write(`${fresh}\r`);
      await session.find('fresh answer after drained typeahead succeeds', text => /TUI host pairing: paired\s/.test(text), answer);
      expect(f.migrations()).toBe(1);
    } finally { await f.stop(); }
  }, 45_000);

  test('switching to the companion /pair surface abandons host confirmation', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      const phrase = await session.prompt(session.command(APPLY));
      const since = session.command('/pair');
      await session.find('the existing companion device pairing modal', text => text.includes('Device Pairing'), since);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
      const dismissed = session.mark(); session.write('\x1b');
      await session.find('return from companion pairing', text => !text.includes('Device Pairing') && text.includes('Ask anything, or type / for commands'), dismissed);
      const fresh = await session.prompt(session.command(APPLY));
      expect(fresh).not.toBe(phrase);
      await cancel(session, 'Escape');
      expect(f.migrations()).toBe(0);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
    } finally { await f.stop(); }
  }, 45_000);

  for (const action of ['Enter', 'wrong phrase', 'Ctrl-C', 'Escape', 'Ctrl-D', 'exit', 'replacement', 'SIGTERM'] as const) {
    test(`${action} at the composer confirmation cancels without minting`, async () => {
      const f = await fixture();
      try {
        const session = await f.launch();
        await session.prompt(session.command(APPLY));
        if (action === 'Enter' || action === 'wrong phrase') {
          const since = session.mark();
          session.write(action === 'Enter' ? '\r' : 'PAIR 000000000000 wrong\r');
          await session.find('wrong answer cancellation', text => /cancelled/i.test(text), since);
        } else await cancel(session, action, f);
        expect(f.migrations()).toBe(0);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
        expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
      } finally { await f.stop(); }
    }, 45_000);
  }

  for (const stage of ['preview', 'revalidation', 'migration', 'verification'] as const) {
    for (const action of ['Ctrl-C', 'Escape', 'Ctrl-D', 'exit', 'replacement', 'SIGTERM'] as const) {
      test(`${action} during ${stage} preserves the true durable outcome after restart`, async () => {
        const f = await fixture();
        try {
          const session = await f.launch();
          f.arm(stage);
          if (stage === 'preview') {
            const since = session.command(APPLY);
            await session.find('visible pending pairing preview', text => text.includes('Reading pairing preview'), since);
          }
          else await confirm(session);
          await waitFor(`held ${stage} response`, f.held, 10_000, 15);
          const expected = stage === 'migration' ? 'unknown' : stage === 'verification' ? 'paired' : 'missing';
          expect(readTuiHostPairing(f.home.home, f.host).status).toBe(expected);
          const saved = expected === 'paired' ? readFileSync(tuiHostPairingStorePath(f.home.home), 'utf8') : undefined;
          await cancel(session, action, f);
          f.release();
          await session.stop();
          const restart = await f.launch();
          const beforeRestartAuth = f.authTokens.length;
          const since = restart.command(APPLY);
          if (expected === 'missing') {
            await restart.prompt(since);
            await cancel(restart, 'Escape');
          } else {
            await restart.find('durable state after restart', text => text.includes(`TUI host pairing: ${expected === 'unknown' ? 'unknown' : 'already-paired'}`), since);
          }
          expect(f.migrations()).toBe(expected === 'missing' ? 0 : 1);
          expect(f.daemon.services.pairingTokens.pairedCount()).toBe(expected === 'missing' ? 0 : 1);
          expect(readTuiHostPairing(f.home.home, f.host).status).toBe(expected);
          if (saved) {
            expect(readFileSync(tuiHostPairingStorePath(f.home.home), 'utf8')).toBe(saved);
            const paired = readTuiHostPairing(f.home.home, f.host);
            if (paired.status !== 'paired') throw new Error('Expected a saved per-host credential');
            expect(f.authTokens.slice(beforeRestartAuth)).toEqual([`Bearer ${paired.token}`]);
          } else if (expected === 'unknown') {
            expect(f.authTokens).toHaveLength(beforeRestartAuth);
          }
        } finally { await f.stop(); }
      }, 60_000);
    }
  }

  test('Escape cancels a fresh restart confirmation even when the terminal never answers palette queries', async () => {
    const f = await fixture();
    try {
      const initial = await f.launch();
      initial.command('/quit'); await initial.exit();
      await initial.stop();
      // A nonresponding terminal leaves the 150ms startup OSC probe open.
      // Its buffered Escape must be forwarded to the pairing owner on timeout.
      const restart = await f.launch(180, 50, false);
      await restart.prompt(restart.command(APPLY));
      await cancel(restart, 'Escape');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('missing');
    } finally { await f.stop(); }
  }, 45_000);

  test('80-column confirmation remains visible after toast expiry and resize; disclosure is scrollable', async () => {
    const f = await fixture();
    try {
      const session = await f.launch(80, 24);
      const phrase = await session.prompt(session.command(APPLY));
      // This deliberately exceeds the old five-second toast lifetime. A resize
      // then requests a fresh frame: old bytes cannot satisfy this assertion.
      await Bun.sleep(5_500);
      let since = session.mark(); session.resize(81, 24);
      await session.find('confirmation survives delayed redraw', text => text.includes(phrase), since);
      since = session.mark(); session.resize(80, 24);
      await session.find('confirmation visible at 80 columns', text => text.includes(phrase), since);
      const normalize = (text: string) => text.replace(/[┃│]/g, '').replace(/\s+/g, ' ');
      const disclosures = [f.host, 'persistent administrative', 'fleet execution', 'existing daemon-global operator token', 'only in this TUI home', 'shared token remains active', 'nothing is revoked'];
      let reviewed = session.screen();
      for (let page = 0; page < 8 && !disclosures.every(part => normalize(reviewed).includes(part)); page++) {
        session.write('\x1b[5~');
        await Bun.sleep(60);
        reviewed += `\n${session.screen()}`;
      }
      for (const disclosure of disclosures) expect(normalize(reviewed)).toContain(disclosure);
      expect(f.migrations()).toBe(0);
      for (let page = 0; page < 8 && !session.screen().includes(phrase); page++) {
        session.write('\x1b[6~'); await Bun.sleep(60);
      }
      expect(session.screen()).toContain(phrase);
      since = session.mark(); session.write(`${phrase}\r`);
      await session.find('confirmed after reviewing persistent disclosure', text => /TUI host pairing: paired\s/.test(text), since);
      expect(f.migrations()).toBe(1);
      expect(readTuiHostPairing(f.home.home, f.host).status).toBe('paired');
    } finally { await f.stop(); }
  }, 45_000);

});


for (const command of ['/workstream start', '/project-plan', '/planning']) {
describe(`compiled interactive TUI native ${command === '/workstream start' ? 'workstream start' : 'planning entry ' + command}`, () => {
  test('real owner command preserves exact source through production capture and survives a lost acknowledgement without legacy fallback', async () => {
    const f = await fixture(true);
    try {
      const session = await f.launch();
      const original = '  Repair  界 e\u0301 😀 @source.ts  ';
      const since = session.command(`${command} ${original}`);
      await session.find('native capture uncertainty', text => text.includes('Native intake outcome is unknown'), since);
      expect(f.nativeCaptures).toHaveLength(1);
      expect(f.nativeCaptures[0]).toMatchObject({ status: 200, body: {
        text: original, unsupportedSources: [{ kind: 'context', label: '@source.ts' }],
      } });
      const retained = readFileSync(join(f.home.home, '.goodvibes/tui/native-work-submission.json.intake'), 'utf8');
      expect(retained).toContain(JSON.stringify(original));
      const again = session.command(`${command} replacement must not become source`);
      await session.find('original source remains unresolved', text => text.includes('An original input is unresolved'), again);
      expect(f.nativeCaptures).toHaveLength(1);
      expect(readFileSync(join(f.home.home, '.goodvibes/tui/native-work-submission.json.intake'), 'utf8')).toBe(retained);
      expect(session.child.exitCode).toBeNull();
      expect(session.text()).not.toContain('new-contract');
    } finally { await f.stop(); }
  }, 30_000);

  test('unpaired native host refuses a real owner start without invoking the legacy model', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      const refusal = 'No TUI credential is bound to this exact daemon origin';
      expect(session.screen()).not.toContain(refusal);
      const since = session.command(`${command} repair the owned fixture`);
      await session.find('unpaired native start is unavailable', text => text.includes(refusal), since);
      expect(session.text(since)).toContain(refusal);
      expect(f.nativeCaptures).toEqual([]);
      expect(existsSync(join(f.home.home, '.goodvibes/tui/native-work-submission.json.intake'))).toBe(false);
      expect(session.child.exitCode).toBeNull();
    } finally { await f.stop(); }
  }, 30_000);
});

}
