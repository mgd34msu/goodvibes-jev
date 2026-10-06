/** Compiled TUI entrypoint, real owner-terminal input, and an owned production daemon. */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore, getProviderModelsCachePath } from '@goodvibes-jev/engine/sdk/platform/providers';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { readTuiHostPairing, tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';
import { resolveBinary, waitFor } from './harness.ts';

const AUTH = '/api/control-plane/auth';
const MIGRATE = '/api/control-plane/methods/pairing.tokens.migrate/invoke';
const PROJECT = '/api/work-ledger/project';
const PROMPT = /Type (PAIR [0-9a-f]{12}) to create/;
type ResponseHold = 'none' | 'preview' | 'revalidation' | 'migration' | 'verification';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

async function fixture(hold: ResponseHold = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'tui-pair-terminal-'));
  const home = join(root, 'tui-home');
  const workspace = join(root, 'workspace');
  mkdirSync(join(home, '.goodvibes', 'tui'), { recursive: true });
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(workspace);
  mkdirSync(join(root, 'tmp'));
  const networkViolations = join(root, 'network-violations.log');
  const guard = resolve(import.meta.dir, '../../../../../packages/engine/scripts/test-network-preload.ts');
  writeFileSync(join(workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`);
  const daemon = await startDaemonFixture({
    root: join(root, 'daemon'), token: 'synthetic-tui-terminal-pairing-bootstrap', hostSessions: false,
    configure(configManager) {
      const homeDirectory = join(root, 'daemon/home');
      seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory: join(root, 'daemon/workspace') });
      const modelList = getProviderModelsCachePath(configManager.getControlPlaneConfigDir(), 'openai');
      mkdirSync(dirname(modelList), { recursive: true });
      writeFileSync(modelList, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: [] }));
      // Daemon composition has consumers of both the shared and TUI cache roots.
      for (const dir of [join(homeDirectory, '.goodvibes'), join(homeDirectory, '.goodvibes/tui')]) {
        const cache = new BenchmarkStore({ dir }).getCachePath();
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
      }
    },
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  }).catch(error => { rmSync(root, { recursive: true, force: true }); throw error; });
  const proxies: Bun.Server<undefined>[] = [];
  try {
    const tokenPath = join(home, '.goodvibes', 'daemon', 'operator-tokens.json');
    const legacy = JSON.stringify({ token: daemon.token });
    writeFileSync(tokenPath, legacy, { mode: 0o600 });
    const gate = deferred();
    let authCalls = 0;
    let migrations = 0;
    let held = false;
    const requests: { origin: string; path: string; method: string; authorization: string | null }[] = [];
    const unexpected: string[] = [];
    function startProxy(withHold: boolean) {
      // Only the response is fault-injected. Authentication and migration still
      // run on the real daemon, including its persisted pairing-token service.
      const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
        const { pathname: path, origin } = new URL(request.url);
        if (path !== AUTH && path !== MIGRATE && path !== PROJECT) { unexpected.push(path); return new Response('Unexpected test route', { status: 404 }); }
        requests.push({ origin, path, method: request.method, authorization: request.headers.get('authorization') });
        if (path === AUTH) authCalls++;
        if (path === MIGRATE) migrations++;
        const response = await fetch(`${daemon.baseUrl}${path}`, {
          method: request.method, headers: request.headers,
          body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
          redirect: 'error',
        });
        // Buffer only after the daemon committed the operation. A withheld
        // mint reply therefore really has an uncertain client-side outcome.
        const body = await response.arrayBuffer();
        if (withHold && ((hold === 'preview' && path === AUTH && authCalls === 1)
          || (hold === 'revalidation' && path === AUTH && authCalls === 2)
          || (hold === 'migration' && path === MIGRATE)
          || (hold === 'verification' && path === AUTH && request.headers.get('authorization') !== `Bearer ${daemon.token}`))) {
          held = true;
          await gate.promise;
        }
        return new Response(body, { status: response.status, headers: response.headers });
      } });
      proxies.push(proxy);
      return proxy.url.origin;
    }
    const host = startProxy(true);
    const otherHost = startProxy(false);
    const env = { PATH: '/usr/bin:/bin', HOME: home, GOODVIBES_HOME: home, TERM: 'xterm-256color',
      LANG: 'C.UTF-8', TMPDIR: join(root, 'tmp'), GOODVIBES_TEST_NETWORK_VIOLATIONS: networkViolations };
    const args = (command: string[]) => [resolveBinary(), ...command];
    const command = (flags: string[] = ['--bootstrap-shared', '--name', 'TUI terminal fixture', '--apply'], origin = host) => [
      'host', 'pair', '--url', origin, ...flags,
    ];
    const nativeStatusCommand = (origin = host) => [
      '--config', `controlPlane.publicBaseUrl=${origin}`, '--config', 'daemon.enabled=true',
      '--output', 'json', 'run', '--intake-status',
    ];
    const children: Bun.Subprocess[] = [];
    function launch(argv = command(), redirect?: 'stdin' | 'stdout') {
      let output = '';
      let overflow = false;
      const decoder = new TextDecoder();
      const redirectedOutput = join(root, `redirected-stdout-${children.length}.log`);
      // A real PTY on only one side must not qualify as an owner terminal.
      const childArgs = redirect ? ['/bin/sh', '-c', redirect === 'stdin' ? 'exec "$@" </dev/null' : 'exec "$@" >"$TUI_PAIR_STDOUT"',
        'tui-pair-terminal-test', ...args(argv)] : args(argv);
      const child = Bun.spawn(childArgs, { cwd: workspace, env: { ...env, TUI_PAIR_STDOUT: redirectedOutput }, terminal: { cols: 180, rows: 40,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true });
          if (output.length > 65_536) { overflow = true; output = output.slice(-65_536); }
        },
      } });
      children.push(child);
      return {
        child, output: () => output + (redirect === 'stdout' && existsSync(redirectedOutput) ? readFileSync(redirectedOutput, 'utf8') : ''),
        write: (text: string) => { child.terminal!.write(text); },
        async prompt() { return await waitFor('TUI pairing terminal prompt', () => PROMPT.exec(output)?.[1], 10_000, 20); },
        async exit() {
          await waitFor('TUI pairing process to exit', () => child.exitCode !== null || child.signalCode !== null, 10_000, 20);
          expect(overflow).toBe(false);
          return await child.exited;
        },
      };
    }
    async function piped(argv: string[], input = '') {
      const child = Bun.spawn(args(argv), { cwd: workspace, env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { out, error, code };
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    }
    return {
      home, host, otherHost, daemon, command, nativeStatusCommand, launch, piped, release: gate.release,
      migrations: () => migrations, authCalls: () => authCalls, held: () => held, requests: () => requests,
      assertPrivateOutput(output: string) {
        expect(output).not.toContain(daemon.token);
        expect(output).not.toContain('gvp_');
        const paired = readTuiHostPairing(home, host);
        if (paired.status === 'paired') expect(output).not.toContain(paired.token);
        expect(readFileSync(tokenPath, 'utf8')).toBe(legacy);
      },
      async stop() {
        // Cleanup is limited to children and loopback listeners owned here.
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await child.exited;
          child.terminal?.close();
        }
        gate.release();
        try { for (const proxy of proxies) await proxy.stop(true); } finally { await daemon.stop(); }
        const violations = existsSync(networkViolations) ? readFileSync(networkViolations, 'utf8') : '';
        rmSync(root, { recursive: true, force: true });
        expect(unexpected).toEqual([]);
        expect(violations).toBe('');
      },
    };
  } catch (error) {
    try { for (const proxy of proxies) await proxy.stop(true); } finally { await daemon.stop(); }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('compiled TUI host pairing terminal', () => {
  test('explicit bootstrap preview and exact confirmation pair once; a fresh process verifies the saved host', async () => {
    const f = await fixture();
    try {
      const noBootstrap = await f.piped(f.command([]));
      expect(noBootstrap.code).not.toBe(0);
      expect(noBootstrap.out).toContain('TUI host pairing: blocked');
      expect(noBootstrap.out).toContain('--bootstrap-shared');
      expect(f.authCalls()).toBe(0);
      expect(f.migrations()).toBe(0);
      const preview = f.launch(f.command(['--bootstrap-shared']));
      expect(await preview.exit()).toBe(0);
      expect(preview.output()).toContain('TUI host pairing: preview');
      expect(preview.output()).toContain('operator-tokens.json');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      const session = f.launch();
      const phrase = await session.prompt();
      expect(session.output()).toContain(f.host);
      expect(session.output()).toContain('persistent administrative');
      expect(session.output()).toContain('operator-tokens.json');
      expect(f.migrations()).toBe(0);
      session.write(`${phrase}\r`);
      expect(await session.exit()).toBe(0);
      expect(session.output()).toContain('TUI host pairing: paired');
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('paired');
      const store = tuiHostPairingStorePath(f.home);
      expect(statSync(store).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(store)).mode & 0o777).toBe(0o700);
      const restart = f.launch(f.command(['--apply']));
      expect(await restart.exit()).toBe(0);
      expect(restart.output()).toContain('TUI host pairing: already-paired');
      expect(restart.output()).not.toMatch(PROMPT);
      const inspection = await f.piped(f.command([]));
      expect(inspection.code).toBe(0);
      expect(inspection.out).toContain('TUI host pairing: already-paired');
      expect(f.migrations()).toBe(1);
      const saved = readTuiHostPairing(f.home, f.host);
      expect(saved.status).toBe('paired');
      if (saved.status !== 'paired') throw new Error('Expected the newly paired credential');
      expect(f.requests().at(-1)?.authorization).toBe(`Bearer ${saved.token}`);
      // Cross the real compiled native consumer boundary after pairing and
      // process restart. With no intake journal, status is intentionally
      // unavailable, but both discovery and principal reads use the saved token.
      const beforeNative = f.requests().length;
      const storedBytes = readFileSync(store, 'utf8');
      const native = await f.piped(f.nativeStatusCommand());
      expect(native.code).toBe(1);
      expect(native.error).toBe('');
      expect(JSON.parse(native.out)).toMatchObject({ stopReason: 'native-unavailable', native: { status: 'unavailable' } });
      expect(native.out).toContain('No retained ordinary input exists for this host, project, workspace and verified principal');
      expect(f.requests().slice(beforeNative)).toEqual([
        { origin: f.host, path: PROJECT, method: 'GET', authorization: `Bearer ${saved.token}` },
        { origin: f.host, path: AUTH, method: 'GET', authorization: `Bearer ${saved.token}` },
      ]);
      expect(readTuiHostPairing(f.home, f.host)).toEqual(saved);
      expect(readFileSync(store, 'utf8')).toBe(storedBytes);
      expect(existsSync(join(f.home, '.goodvibes/tui/native-work-submission.json.intake'))).toBe(false);
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      f.assertPrivateOutput(noBootstrap.out + noBootstrap.error + preview.output() + session.output() + restart.output() + inspection.out + inspection.error + native.out + native.error);
    } finally { await f.stop(); }
  }, 30_000);

  test('a different loopback origin cannot inherit the first origin credential or bootstrap choice', async () => {
    const f = await fixture();
    try {
      const session = f.launch();
      session.write(`${await session.prompt()}\r`);
      expect(await session.exit()).toBe(0);
      const saved = readTuiHostPairing(f.home, f.host);
      expect(saved.status).toBe('paired');
      const requestsBefore = f.requests().length;
      const blocked = await f.piped(f.command([], f.otherHost));
      expect(blocked.code).not.toBe(0);
      expect(blocked.out).toContain('TUI host pairing: blocked');
      expect(f.requests()).toHaveLength(requestsBefore);
      const native = await f.piped(f.nativeStatusCommand(f.otherHost));
      expect(native.code).toBe(1);
      expect(native.error).toBe('');
      expect(JSON.parse(native.out)).toMatchObject({ stopReason: 'native-unavailable', native: { status: 'unavailable' } });
      expect(native.out).toContain('No TUI credential is bound to this exact daemon origin');
      expect(f.requests()).toHaveLength(requestsBefore);
      const preview = await f.piped(f.command(['--bootstrap-shared'], f.otherHost));
      expect(preview.code).toBe(0);
      expect(preview.out).toContain('TUI host pairing: preview');
      expect(preview.out).toContain(f.otherHost);
      expect(f.requests().at(-1)).toMatchObject({ origin: f.otherHost, path: AUTH, authorization: `Bearer ${f.daemon.token}` });
      expect(readTuiHostPairing(f.home, f.otherHost).status).toBe('missing');
      expect(readTuiHostPairing(f.home, f.host)).toEqual(saved);
      expect(f.migrations()).toBe(1);
      f.assertPrivateOutput(session.output() + blocked.out + blocked.error + native.out + native.error + preview.out + preview.error);
    } finally { await f.stop(); }
  }, 30_000);

  for (const cancel of ['Enter', 'wrong phrase', 'Ctrl-C', 'Ctrl-D', 'SIGTERM'] as const) {
    test(`${cancel} at the real prompt cancels without creating a credential`, async () => {
      const f = await fixture();
      try {
        const session = f.launch();
        await session.prompt();
        if (cancel === 'SIGTERM') session.child.kill('SIGTERM');
        else session.write(cancel === 'Enter' ? '\r' : cancel === 'wrong phrase' ? 'yes\r' : cancel === 'Ctrl-C' ? '\x03' : '\x04');
        expect(await session.exit()).toBe(cancel === 'Enter' || cancel === 'wrong phrase' ? 2 : 130);
        expect(session.output()).toMatch(/TUI host pairing: cancelled|Pairing interrupted/);
        expect(f.migrations()).toBe(0);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
        expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
        f.assertPrivateOutput(session.output());
      } finally { await f.stop(); }
    }, 20_000);
  }

  test('a previous preview confirmation phrase cannot approve a fresh terminal session', async () => {
    const f = await fixture();
    try {
      const first = f.launch();
      const stale = await first.prompt();
      first.write('\x03');
      expect(await first.exit()).toBe(130);
      const second = f.launch();
      expect(await second.prompt()).not.toBe(stale);
      second.write(`${stale}\r`);
      expect(await second.exit()).toBe(2);
      expect(second.output()).toContain('TUI host pairing: cancelled');
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      f.assertPrivateOutput(first.output() + second.output());
    } finally { await f.stop(); }
  }, 30_000);

  test('complete and partial pre-preview typeahead cannot supply the later confirmation', async () => {
    const f = await fixture('preview');
    try {
      const session = f.launch();
      await waitFor('held preview before typeahead', f.held, 10_000, 20);
      session.write('PAIR 000000000000\rtyped-before-preview');
      await waitFor('owner terminal to consume pre-preview typeahead', () => session.output().includes('typed-before-preview'), 1000, 20);
      f.release();
      const phrase = await session.prompt();
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      session.write(`${phrase}\r`);
      expect(await session.exit()).toBe(0);
      expect(session.output()).toContain('TUI host pairing: paired');
      expect(f.migrations()).toBe(1);
      f.assertPrivateOutput(session.output());
    } finally { await f.stop(); }
  }, 30_000);

  for (const hold of ['preview', 'revalidation'] as const) {
    for (const interruption of ['Ctrl-C', 'Ctrl-D', 'SIGTERM'] as const) {
      test(`${interruption} during ${hold} cancels before a mutation marker or mint request`, async () => {
        const f = await fixture(hold);
        try {
          const session = f.launch();
          if (hold === 'revalidation') session.write(`${await session.prompt()}\r`);
          await waitFor(`held ${hold} response`, f.held, 10_000, 20);
          expect(session.output()).toContain('operator-tokens.json');
          if (interruption === 'SIGTERM') session.child.kill('SIGTERM');
          else session.write(interruption === 'Ctrl-C' ? '\x03' : '\x04');
          expect(await session.exit()).toBe(130);
          expect(session.output()).toContain('TUI host pairing: cancelled');
          expect(f.migrations()).toBe(0);
          expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
          expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
          f.assertPrivateOutput(session.output());
        } finally { await f.stop(); }
      }, 20_000);
    }
  }

  for (const interruption of ['Ctrl-C', 'Ctrl-D', 'SIGKILL', 'lost reply'] as const) {
    test(`${interruption} after the real daemon mint preserves uncertainty and blocks remint across restart`, async () => {
      const f = await fixture('migration');
      try {
        const session = f.launch();
        session.write(`${await session.prompt()}\r`);
        await waitFor('committed daemon migration with withheld response', f.held, 10_000, 20);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
        expect(readTuiHostPairing(f.home, f.host).status).toBe('unknown');
        if (interruption === 'SIGKILL') session.child.kill('SIGKILL');
        else if (interruption !== 'lost reply') session.write(interruption === 'Ctrl-C' ? '\x03' : '\x04');
        expect(await session.exit()).toBe(interruption === 'SIGKILL' ? 137 : interruption === 'lost reply' ? 1 : 130);
        if (interruption !== 'SIGKILL') expect(session.output()).toContain('TUI host pairing: unknown');
        f.release();
        const authCalls = f.authCalls();
        for (const flags of [[], ['--bootstrap-shared', '--apply']]) {
          const restart = f.launch(f.command(flags));
          expect(await restart.exit()).toBe(1);
          expect(restart.output()).toContain('TUI host pairing: unknown');
          expect(restart.output()).not.toMatch(PROMPT);
          f.assertPrivateOutput(restart.output());
        }
        expect(f.authCalls()).toBe(authCalls);
        expect(f.migrations()).toBe(1);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
        expect(readTuiHostPairing(f.home, f.host).status).toBe('unknown');
        f.assertPrivateOutput(session.output());
      } finally { await f.stop(); }
    }, 30_000);
  }

  for (const interruption of ['Ctrl-C', 'Ctrl-D'] as const) {
    test(`${interruption} after local storage retains the sole credential for verification on restart`, async () => {
      const f = await fixture('verification');
      try {
        const session = f.launch();
        session.write(`${await session.prompt()}\r`);
        await waitFor('held post-storage verification', f.held, 10_000, 20);
        const saved = readTuiHostPairing(f.home, f.host);
        expect(saved.status).toBe('paired');
        session.write(interruption === 'Ctrl-C' ? '\x03' : '\x04');
        expect(await session.exit()).toBe(130);
        expect(session.output()).toContain('TUI host pairing: paired-unverified');
        f.release();
        const restart = f.launch(f.command(['--apply']));
        expect(await restart.exit()).toBe(0);
        expect(restart.output()).toContain('TUI host pairing: already-paired');
        expect(restart.output()).not.toMatch(PROMPT);
        expect(readTuiHostPairing(f.home, f.host)).toEqual(saved);
        expect(f.migrations()).toBe(1);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
        f.assertPrivateOutput(session.output() + restart.output());
      } finally { await f.stop(); }
    }, 30_000);
  }

  test('compiled non-TTY apply rejects scripted approval before any host request', async () => {
    const f = await fixture();
    try {
      const result = await f.piped(f.command(), 'yes\nPAIR 000000000000\n');
      expect(result.code).toBe(2);
      expect(result.out).toContain('No credential was created');
      expect(result.out).toContain('owner terminal');
      expect(f.authCalls()).toBe(0);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      f.assertPrivateOutput(result.out + result.error);
    } finally { await f.stop(); }
  }, 20_000);

  for (const redirect of ['stdin', 'stdout'] as const) {
    test(`compiled apply with only ${redirect === 'stdin' ? 'stdout' : 'stdin'} on a TTY cannot approve pairing`, async () => {
      const f = await fixture();
      try {
        const session = f.launch(f.command(), redirect);
        expect(await session.exit()).toBe(2);
        expect(session.output()).toContain('No credential was created');
        expect(session.output()).not.toMatch(PROMPT);
        expect(f.authCalls()).toBe(0);
        expect(f.migrations()).toBe(0);
        expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
        f.assertPrivateOutput(session.output());
      } finally { await f.stop(); }
    }, 20_000);
  }

  test('--yes is rejected even from a real owner terminal', async () => {
    const f = await fixture();
    try {
      const session = f.launch(f.command(['--bootstrap-shared', '--apply', '--yes']));
      expect(await session.exit()).toBe(2);
      expect(session.output()).toContain('--yes and scripted approval are unsupported');
      expect(session.output()).not.toMatch(PROMPT);
      expect(f.authCalls()).toBe(0);
      expect(f.migrations()).toBe(0);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      f.assertPrivateOutput(session.output());
    } finally { await f.stop(); }
  }, 20_000);
});
