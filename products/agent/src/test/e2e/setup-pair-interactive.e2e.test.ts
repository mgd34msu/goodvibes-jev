/** Compiled interactive shell, real PTY, and an owned synthetic loopback host. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { agentHostPairingStorePath, readAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { isolatedEnv, makeHome, removeHome, resolveBinary, startStubModel, waitFor, WORKSPACE_QUESTION } from './harness.ts';

const AUTH = '/api/control-plane/auth';
const MIGRATE = '/api/control-plane/methods/pairing.tokens.migrate/invoke';
const APPLY = '/setup pair --apply';
// Shell background discovery/registration is outside this auth-only fixture.
// These are denied locally, never forwarded as mutations to the real daemon.
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
type Cancel = 'Ctrl-C' | 'Escape' | 'Ctrl-D' | 'exit' | 'replacement';

import { TerminalFrame } from './terminal-frame.ts';
import { observeOwnedWorkspaceDecline, ownerWorkspaceStartupReadiness } from '../helpers/owner-workspace-startup.ts';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(environmentOverride = false) {
  const model = startStubModel(() => ({ text: 'Unexpected pairing model request' }));
  const home = await makeHome(model).catch(error => { model.stop(); throw error; });
  mkdirSync(join(home.root, 'tmp'), { recursive: true });
  const daemonRoot = join(home.root, 'pairing-host');
  const daemon = await startDaemonFixture({ root: daemonRoot, token: 'synthetic-interactive-pairing-bootstrap', hostSessions: false,
    configure(configManager) {
      const homeDirectory = join(daemonRoot, 'home');
      seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory: join(daemonRoot, 'workspace'), surfaceRoot: 'goodvibes' });
      seedProviderModelListCacheFixture(configManager, 'openai');
      const cache = new BenchmarkStore({ dir: join(homeDirectory, '.goodvibes/tui') }).getCachePath();
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
    },
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  }).catch(error => { model.stop(); removeHome(home); throw error; });
  let stopProxy: (() => Promise<void>) | undefined;
  try {
    const legacyPath = join(home.daemonHome, 'operator-tokens.json');
    writeFileSync(legacyPath, JSON.stringify({ token: daemon.token }));
    const sharedFiles = [legacyPath, join(home.daemonHome, 'settings.json')].map(path => ({ path, bytes: readFileSync(path) }));
    const gate = deferred();
    const requests = new AbortController();
    let hold: Hold | undefined;
    let pairingAuthCalls = 0;
    let migrations = 0;
    let completedAuth = 0;
    let held = false;
    const authTokens: Array<string | null> = [];
    const unexpectedMutations: string[] = [];
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      // Startup discovery/event routes are deliberately absent: this owned
      // front door exposes only real pairing auth/migration handlers. No
      // revoke/delete/cleanup mutation can pass.
      if (request.method !== 'GET' && request.method !== 'HEAD' && path !== MIGRATE && !BACKGROUND_ROUTES.has(path) && !/^\/api\/sessions\/[^/]+\/close$/.test(path)) {
        unexpectedMutations.push(`${request.method} ${path}`);
        return new Response('Unexpected test mutation', { status: 403 });
      }
      if (path !== AUTH && path !== MIGRATE) return new Response('Not part of the pairing fixture', { status: 404 });
      const authOrdinal = path === AUTH ? ++pairingAuthCalls : 0;
      if (path === AUTH) {
        authTokens.push(request.headers.get('authorization'));
      }
      if (path === MIGRATE) migrations++;
      const response = await fetch(`${daemon.baseUrl}${path}${url.search}`, {
        method: request.method, headers: request.headers,
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
        redirect: 'error', signal: AbortSignal.any([requests.signal, request.signal]),
      });
      // Hold only after the production handler has finished. A withheld POST
      // reply therefore means the real daemon has already issued one secret.
      const body = await response.arrayBuffer();
      if (!held && ((hold === 'preview' && path === AUTH && authOrdinal === 1)
        || (hold === 'revalidation' && path === AUTH && authOrdinal === 2)
        || (hold === 'migration' && path === MIGRATE)
        || (hold === 'verification' && path === AUTH && request.headers.get('authorization') !== `Bearer ${daemon.token}`))) {
        held = true;
        await gate.promise;
      }
      if (path === AUTH) completedAuth++;
      return new Response(body, { status: response.status, headers: response.headers });
    } });
    stopProxy = async () => { requests.abort(); gate.release(); await proxy.stop(true); };
    const host = proxy.url.origin;
    const env = isolatedEnv(home, { GOODVIBES_AGENT_HOME: home.home, GOODVIBES_AGENT_RUNTIME_URL: host,
      ...(environmentOverride ? { GOODVIBES_CONNECTED_HOST_TOKEN: daemon.token } : {}) });
    const sessions: Array<{ stop(): Promise<void>; assertOutput(): void }> = [];
    function spawn(cols = 180, rows = 50, paletteReplies = true) {
      const frame = new TerminalFrame(cols, rows);
      const phrasesSeen = new Set<string>();
      const commandPhrases = new Map<number, Set<string>>();
      let output = '';
      let overflow = false;
      let stopped = false;
      const decoder = new TextDecoder();
      const child = Bun.spawn([resolveBinary(), '--working-dir', home.workspace, '--runtime-url', host], {
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
    let workspaceAnswered = false;
    async function launch(cols = 180, rows = 50, paletteReplies = true) {
      const isRestart = workspaceAnswered;
      const session = spawn(cols, rows, paletteReplies);
      if (!workspaceAnswered) {
        await session.find('first workspace question', text => text.includes(WORKSPACE_QUESTION));
        const since = session.mark();
        session.write('\r');
        await session.find('workspace question answered', text => text.includes('Ask anything, or type / for commands') && !text.includes(WORKSPACE_QUESTION), since);
      } else {
        await session.find('interactive input', text => text.includes('Ask anything, or type / for commands') && !text.includes(WORKSPACE_QUESTION));
      }
      // First paint can precede stdin subscription, and dismissing the modal
      // can precede its async decline write. Within the same readiness budget,
      // require the owned stored decline and an unsent real-composer echo.
      try { await waitFor('live owner composer', () => {
        const readiness = ownerWorkspaceStartupReadiness(session.screen(), home);
        if (readiness.ready) return true;
        if (readiness.canEcho) session.write('\x15x');
        return false;
      }, 10_000, 30); } catch (error) {
        // This error reaches the runner only after the test's existing finally
        // drains the fixture. Bound and redact the current frame, never raw PTY
        // history or stored pairing credentials.
        let registration: unknown;
        try {
          const observed = observeOwnedWorkspaceDecline(home);
          registration = { byteCount: observed.byteCount, sha256: observed.sha256, ownedDecline: observed.ownedDecline };
        } catch { registration = { byteCount: null, sha256: null, ownedDecline: false }; }
        let diagnostic = `${String(error)}\nregistration=${JSON.stringify(registration)}\nrestart=${isRestart} exit=${session.child.exitCode} signal=${session.child.signalCode} bytes=${session.output().length}\n--- current terminal ---\n${session.screen()}`;
        for (const token of [daemon.token, ...authTokens.map(value => value?.replace(/^Bearer\s+/i, ''))]) {
          if (token) diagnostic = diagnostic.replaceAll(token, '[fixture credential]');
        }
        diagnostic = diagnostic.replace(/\bBearer\s+[^\s]+|gvp_[A-Za-z0-9_-]+/gi, '[fixture credential]');
        throw new Error(diagnostic.length > 12_000 ? `${diagnostic.slice(0, 12_000)}\n[diagnostic truncated]` : diagnostic);
      }
      const cleared = session.mark(); session.write('\x15');
      await session.find('empty live owner composer', text => text.includes('Ask anything, or type / for commands') && !text.includes('┃  x') && !text.includes(WORKSPACE_QUESTION), cleared);
      workspaceAnswered = true;
      return session;
    }
    async function status() {
      const child = Bun.spawn([resolveBinary(), '--working-dir', home.workspace, '--runtime-url', host, 'setup', 'status', '--json'], {
        cwd: home.workspace, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0); expect(error).toBe('');
        expect(out).not.toContain(daemon.token); expect(out).not.toContain('gvp_');
        return JSON.parse(out) as { pairingStatus: string; nativeReadiness: { status: string } };
      } finally { clearTimeout(deadline); }
    }
    return { home, host, daemon, launch, status, release: gate.release,
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
        } finally { model.stop(); removeHome(home); }
      },
    };
  } catch (error) {
    try { await stopProxy?.(); } finally { try { await daemon.stop(); } finally { model.stop(); removeHome(home); } }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<Fixture['launch']>>;

async function cancel(session: Session, action: Cancel, f?: Fixture) {
  const since = session.mark();
  if (action === 'exit') { session.command('/quit'); await session.exit(); return; }
  if (action === 'replacement') {
    const completedAuth = f!.completedAuth();
    const unknown = readAgentHostPairing(f!.home.home, f!.host).status === 'unknown';
    session.command('/setup pair');
    await session.find('replacement cancels the earlier operation', text => /cancelled|interrupted|Agent host pairing: (unknown|paired-unverified)/i.test(text), since);
    if (!unknown) await waitFor('fresh replacement authority response', () => f!.completedAuth() > completedAuth, 10_000, 15);
    await session.find('replacement pairing result', text => /Agent host pairing: (preview|unknown|already-paired)/.test(text), since);
    return;
  }
  session.write(action === 'Ctrl-C' ? '\x03' : action === 'Escape' ? '\x1b' : '\x04');
  await session.find('pairing interruption result', text => /cancelled|interrupted|Agent host pairing: (unknown|paired-unverified)/i.test(text), since);
  expect(session.child.exitCode).toBeNull();
}

async function confirm(session: Session) {
  const since = session.command(APPLY);
  const phrase = await session.prompt(since);
  const answer = session.mark();
  session.write(`${phrase}\r`);
  return answer;
}

describe('compiled interactive owner pairing', () => {
  test('preview is read-only; exact composer confirmation pairs once and survives a fresh shell', async () => {
    const f = await fixture();
    try {
      const session = await f.launch();
      let since = session.command('/setup pair');
      await session.find('read-only pairing preview', text => text.includes('Agent host pairing: preview'), since);
      expect(f.migrations()).toBe(0);
      expect(readAgentHostPairing(f.home.home, f.host).status).toBe('missing');
      since = session.command(APPLY);
      const phrase = await session.prompt(since);
      const preview = session.screen().replace(/[┃│]/g, '').replace(/\s+/g, ' ');
      expect(preview).toContain(f.host);
      expect(preview).toContain('persistent administrative');
      expect(f.migrations()).toBe(0);
      const answer = session.mark();
      session.write(`${phrase}\r`);
      await session.find('verified pairing result', text => /Agent host pairing: paired\s/.test(text), answer);
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      expect(readAgentHostPairing(f.home.home, f.host).status).toBe('paired');
      const store = agentHostPairingStorePath(f.home.home);
      expect(statSync(store).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(store)).mode & 0o777).toBe(0o700);
      expect(await f.status()).toMatchObject({ pairingStatus: 'paired', nativeReadiness: { status: 'ready' } });
      await session.stop();
      const restart = await f.launch();
      const restartSince = restart.command(APPLY);
      await restart.find('saved pairing is not reminted', text => text.includes('Agent host pairing: already-paired'), restartSince);
      expect(f.migrations()).toBe(1);
    } finally { await f.stop(); }
  }, 60_000);

  for (const action of ['Enter', 'wrong phrase', 'Ctrl-C', 'Escape', 'Ctrl-D', 'exit', 'replacement'] as const) {
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
        expect(readAgentHostPairing(f.home.home, f.host).status).toBe('missing');
      } finally { await f.stop(); }
    }, 45_000);
  }

  for (const stage of ['preview', 'revalidation', 'migration', 'verification'] as const) {
    for (const action of ['Ctrl-C', 'Escape', 'Ctrl-D', 'exit', 'replacement'] as const) {
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
          expect(readAgentHostPairing(f.home.home, f.host).status).toBe(expected);
          const saved = expected === 'paired' ? readFileSync(agentHostPairingStorePath(f.home.home), 'utf8') : undefined;
          await cancel(session, action, f);
          f.release();
          await session.stop();
          const restart = await f.launch();
          const since = restart.command(APPLY);
          if (expected === 'missing') {
            await restart.prompt(since);
            await cancel(restart, 'Escape');
          } else {
            await restart.find('durable state after restart', text => text.includes(`Agent host pairing: ${expected === 'unknown' ? 'unknown' : 'already-paired'}`), since);
          }
          expect(f.migrations()).toBe(expected === 'missing' ? 0 : 1);
          expect(f.daemon.services.pairingTokens.pairedCount()).toBe(expected === 'missing' ? 0 : 1);
          expect(readAgentHostPairing(f.home.home, f.host).status).toBe(expected);
          if (saved) {
            expect(readFileSync(agentHostPairingStorePath(f.home.home), 'utf8')).toBe(saved);
            expect(await f.status()).toMatchObject({ pairingStatus: 'paired', nativeReadiness: { status: 'ready' } });
          } else if (expected === 'unknown') {
            const before = f.authTokens.length;
            expect(await f.status()).toMatchObject({ pairingStatus: 'unknown', nativeReadiness: { status: 'missing-credential' } });
            expect(f.authTokens).toHaveLength(before);
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
      expect(readAgentHostPairing(f.home.home, f.host).status).toBe('missing');
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
      const disclosures = [f.host, 'persistent administrative', 'fleet execution', 'only in this Agent home', 'legacy shared token remains active', 'no credential is revoked'];
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
      await session.find('confirmed after reviewing persistent disclosure', text => /Agent host pairing: paired\s/.test(text), since);
      expect(f.migrations()).toBe(1);
      expect(readAgentHostPairing(f.home.home, f.host).status).toBe('paired');
    } finally { await f.stop(); }
  }, 45_000);

  test('a retained environment override is disclosed and keeps precedence after interactive pairing', async () => {
    const f = await fixture(true);
    try {
      const session = await f.launch();
      const since = session.command(APPLY);
      const phrase = await session.prompt(since);
      expect(session.screen().replace(/\s+/g, ' ')).toContain('Environment token takes precedence');
      const answer = session.mark(); session.write(`${phrase}\r`);
      await session.find('environment shadowing result', text => text.includes('Agent host pairing: paired-shadowed'), answer);
      const tokenReads = f.authTokens.length;
      const again = session.command('/setup pair');
      await session.find('effective environment authority retained', text => text.includes('Agent host pairing: already-paired'), again);
      expect(f.authTokens.slice(tokenReads)).toContain(`Bearer ${f.daemon.token}`);
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
    } finally { await f.stop(); }
  }, 45_000);
});
