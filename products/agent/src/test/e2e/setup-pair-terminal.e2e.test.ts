/** Real compiled entrypoint, real PTY input and an owned loopback daemon. */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { agentHostPairingStorePath, readAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { resolveBinary, waitFor } from './harness.ts';

const AUTH = '/api/control-plane/auth';
const MIGRATE = '/api/control-plane/methods/pairing.tokens.migrate/invoke';
const PROMPT = /Type (PAIR [0-9a-f]{12}) to create/;
type ResponseHold = 'none' | 'preview' | 'revalidation' | 'migration' | 'verification';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

async function fixture(hold: ResponseHold = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'agent-pair-terminal-'));
  const home = join(root, 'agent-home');
  const workspace = join(root, 'workspace');
  mkdirSync(join(home, '.goodvibes', 'agent'), { recursive: true });
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(workspace);
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(home, '.goodvibes', 'agent', 'settings.json'), JSON.stringify({ update: { auto: false, autoUpdateAtLaunch: false } }));
  const networkViolations = join(root, 'network-violations.log');
  const guard = resolve(import.meta.dir, '../../../../../packages/engine/scripts/test-network-preload.ts');
  writeFileSync(join(workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`);
  const daemon = await startDaemonFixture({
    root: join(root, 'daemon'), token: 'synthetic-terminal-pairing-bootstrap', hostSessions: false,
    configure(configManager) {
      const homeDirectory = join(root, 'daemon/home');
      seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory: join(root, 'daemon/workspace'), surfaceRoot: 'goodvibes' });
      seedProviderModelListCacheFixture(configManager, 'openai');
      const cache = new BenchmarkStore({ dir: join(homeDirectory, '.goodvibes/tui') }).getCachePath();
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
    },
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  }).catch(error => { rmSync(root, { recursive: true, force: true }); throw error; });
  let stopProxy: (() => Promise<void>) | undefined;
  try {
    const tokenPath = join(home, '.goodvibes', 'daemon', 'operator-tokens.json');
    const legacy = JSON.stringify({ token: daemon.token });
    writeFileSync(tokenPath, legacy);
    const gate = deferred();
    let authCalls = 0;
    let migrations = 0;
    let held = false;
    const unexpected: string[] = [];
    // The proxy forwards production auth and migration handlers unchanged. It
    // can withhold a reply only after the real daemon completed that operation.
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== AUTH && path !== MIGRATE) { unexpected.push(path); return new Response('Unexpected test route', { status: 404 }); }
      if (path === AUTH) authCalls++;
      if (path === MIGRATE) migrations++;
      const response = await fetch(`${daemon.baseUrl}${path}`, {
        method: request.method, headers: request.headers,
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
        redirect: 'error',
      });
      // Buffer the real response before fault injection, proving the daemon
      // committed its operation even if the Agent never receives its secret.
      const body = await response.arrayBuffer();
      if ((hold === 'preview' && path === AUTH && authCalls === 1)
        || (hold === 'revalidation' && path === AUTH && authCalls === 2)
        || (hold === 'migration' && path === MIGRATE)
        || (hold === 'verification' && path === AUTH && request.headers.get('authorization') !== `Bearer ${daemon.token}`)) {
        held = true;
        await gate.promise;
      }
      return new Response(body, { status: response.status, headers: response.headers });
    } });
    stopProxy = async () => { await proxy.stop(true); };
    const host = proxy.url.origin;
    const env = { PATH: '/usr/bin:/bin', HOME: home, GOODVIBES_AGENT_HOME: home, TERM: 'xterm-256color',
      LANG: 'C.UTF-8', TMPDIR: join(root, 'tmp'), GOODVIBES_TEST_NETWORK_VIOLATIONS: networkViolations };
    const args = (command: string[]) => [resolveBinary(), '--working-dir', workspace, '--runtime-url', host, ...command];
    const children: Bun.Subprocess[] = [];
    function launch(command = ['setup', 'pair', '--name', 'Terminal fixture', '--apply']) {
      let output = '';
      let overflow = false;
      const decoder = new TextDecoder();
      const child = Bun.spawn(args(command), { cwd: workspace, env, terminal: { cols: 180, rows: 40,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true });
          if (output.length > 65_536) { overflow = true; output = output.slice(-65_536); }
        },
      } });
      const session = {
        child, output: () => output,
        write: (text: string) => { child.terminal!.write(text); },
        async prompt() { return await waitFor('pairing terminal prompt', () => PROMPT.exec(output)?.[1], 10_000); },
        async exit() {
          await waitFor('pairing process to exit', () => child.exitCode !== null || child.signalCode !== null, 10_000);
          expect(overflow).toBe(false);
          return await child.exited;
        },
      };
      children.push(child);
      return session;
    }
    async function piped(command: string[], input = '') {
      const child = Bun.spawn(args(command), { cwd: workspace, env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
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
      home, host, daemon, launch, piped, release: gate.release,
      migrations: () => migrations, authCalls: () => authCalls, held: () => held,
      assertPrivateOutput(output: string) {
        expect(output).not.toContain(daemon.token);
        expect(output).not.toContain('gvp_');
        expect(readFileSync(tokenPath, 'utf8')).toBe(legacy);
      },
      async stop() {
        // Every child, including failed assertions and timed-out prompts, belongs
        // to this fixture; never kill a process discovered by name or port.
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await child.exited;
          child.terminal?.close();
        }
        gate.release();
        try { await proxy.stop(true); } finally { await daemon.stop(); }
        const violations = existsSync(networkViolations) ? readFileSync(networkViolations, 'utf8') : '';
        rmSync(root, { recursive: true, force: true });
        expect(unexpected).toEqual([]);
        expect(violations).toBe('');
      },
    };
  } catch (error) {
    try { await stopProxy?.(); } finally { await daemon.stop(); }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('compiled setup pairing terminal', () => {
  test('exact confirmation pairs once; a fresh process verifies saved authority without reminting', async () => {
    const f = await fixture();
    try {
      const preview = f.launch(['setup', 'pair']);
      expect(await preview.exit()).toBe(0);
      expect(preview.output()).toContain('Agent host pairing: preview');
      expect(f.migrations()).toBe(0);
      expect(readAgentHostPairing(f.home, f.host).status).toBe('missing');
      const session = f.launch();
      const phrase = await session.prompt();
      expect(session.output()).toContain(f.host);
      expect(session.output()).toContain('persistent administrative');
      expect(f.migrations()).toBe(0);
      session.write(`${phrase}\r`);
      expect(await session.exit()).toBe(0);
      expect(session.output()).toContain('Agent host pairing: paired');
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      expect(readAgentHostPairing(f.home, f.host).status).toBe('paired');
      const store = agentHostPairingStorePath(f.home);
      expect(statSync(store).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(store)).mode & 0o777).toBe(0o700);
      const status = await f.piped(['setup', 'status', '--json']);
      expect(status.code).toBe(0); expect(status.error).toBe('');
      expect(JSON.parse(status.out)).toMatchObject({ pairingStatus: 'paired', selectedHost: f.host, nativeReadiness: { status: 'ready' } });
      const restart = f.launch();
      expect(await restart.exit()).toBe(0);
      expect(restart.output()).toContain('already-paired');
      expect(restart.output()).not.toMatch(PROMPT);
      expect(f.migrations()).toBe(1);
      f.assertPrivateOutput(preview.output() + session.output() + restart.output() + status.out);
    } finally { await f.stop(); }
  }, 30_000);

  for (const cancel of ['Enter', 'wrong phrase', 'Ctrl-C', 'Ctrl-D', 'SIGTERM'] as const) {
    test(`${cancel} at the real prompt reports cancellation and creates no credential`, async () => {
      const f = await fixture();
      try {
        const session = f.launch();
        await session.prompt();
        if (cancel === 'SIGTERM') session.child.kill('SIGTERM');
        else session.write(cancel === 'Enter' ? '\r' : cancel === 'wrong phrase' ? 'yes\r' : cancel === 'Ctrl-C' ? '\x03' : '\x04');
        expect(await session.exit()).toBe(cancel === 'Enter' || cancel === 'wrong phrase' ? 2 : 130);
        expect(session.output()).toMatch(/Pairing (cancelled|interrupted)/);
        expect(f.migrations()).toBe(0);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
        expect(readAgentHostPairing(f.home, f.host).status).toBe('missing');
        f.assertPrivateOutput(session.output());
      } finally { await f.stop(); }
    }, 20_000);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`${signal} during the preview exits as interrupted before any mutation`, async () => {
      const f = await fixture('preview');
      try {
        const session = f.launch();
        await waitFor('held preview response', f.held, 10_000);
        session.child.kill(signal);
        expect(await session.exit()).toBe(130);
        expect(session.output()).toContain('cancelled');
        expect(f.migrations()).toBe(0);
        expect(readAgentHostPairing(f.home, f.host).status).toBe('missing');
      } finally { await f.stop(); }
    }, 20_000);
  }

  for (const interruption of ['Ctrl-C', 'SIGINT', 'SIGTERM'] as const) {
    test(`${interruption} during post-answer revalidation cancels before creating the marker`, async () => {
      const f = await fixture('revalidation');
      try {
        const session = f.launch();
        session.write(`${await session.prompt()}\r`);
        await waitFor('held fresh authority revalidation', f.held, 10_000);
        if (interruption === 'Ctrl-C') session.write('\x03');
        else session.child.kill(interruption);
        expect(await session.exit()).toBe(130);
        expect(session.output()).toContain('cancelled');
        expect(f.migrations()).toBe(0);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(0);
        expect(readAgentHostPairing(f.home, f.host).status).toBe('missing');
      } finally { await f.stop(); }
    }, 20_000);
  }

  for (const interruption of ['Ctrl-C', 'Ctrl-D', 'SIGKILL', 'lost reply'] as const) {
    test(`${interruption} after daemon migration preserves unknown outcome across restart`, async () => {
      const f = await fixture('migration');
      try {
        const session = f.launch();
        session.write(`${await session.prompt()}\r`);
        await waitFor('committed daemon migration with withheld response', f.held, 10_000);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
        expect(readAgentHostPairing(f.home, f.host).status).toBe('unknown');
        if (interruption === 'SIGKILL') session.child.kill('SIGKILL');
        else if (interruption !== 'lost reply') session.write(interruption === 'Ctrl-C' ? '\x03' : '\x04');
        const code = await session.exit();
        expect(code).toBe(interruption === 'SIGKILL' ? 137 : interruption === 'lost reply' ? 1 : 130);
        if (interruption !== 'SIGKILL') expect(session.output()).toContain('Agent host pairing: unknown');
        f.release();
        const authCalls = f.authCalls();
        for (const command of [['setup', 'pair'], ['setup', 'pair', '--apply']]) {
          const restart = f.launch(command);
          expect(await restart.exit()).toBe(1);
          expect(restart.output()).toContain('Agent host pairing: unknown');
          expect(restart.output()).not.toMatch(PROMPT);
          f.assertPrivateOutput(restart.output());
        }
        expect(f.migrations()).toBe(1);
        const status = await f.piped(['setup', 'status', '--json']);
        expect(status.code).toBe(0); expect(status.error).toBe('');
        expect(JSON.parse(status.out)).toMatchObject({ pairingStatus: 'unknown', nativeReadiness: { status: 'missing-credential' } });
        expect(f.authCalls()).toBe(authCalls);
        expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
        expect(readAgentHostPairing(f.home, f.host).status).toBe('unknown');
        f.assertPrivateOutput(session.output() + status.out);
      } finally { await f.stop(); }
    }, 30_000);
  }

  test('Ctrl-C after storage retains the sole secret and a fresh status verifies it', async () => {
    const f = await fixture('verification');
    try {
      const session = f.launch();
      session.write(`${await session.prompt()}\r`);
      await waitFor('held post-storage verification', f.held, 10_000);
      expect(readAgentHostPairing(f.home, f.host).status).toBe('paired');
      session.write('\x03');
      expect(await session.exit()).toBe(130);
      expect(session.output()).toContain('paired-unverified');
      f.release();
      const status = await f.piped(['setup', 'status', '--json']);
      expect(status.code).toBe(0); expect(status.error).toBe('');
      expect(JSON.parse(status.out)).toMatchObject({ pairingStatus: 'paired', nativeReadiness: { status: 'ready' } });
      const restart = f.launch();
      expect(await restart.exit()).toBe(0);
      expect(restart.output()).toContain('already-paired');
      expect(f.migrations()).toBe(1);
      expect(f.daemon.services.pairingTokens.pairedCount()).toBe(1);
      f.assertPrivateOutput(session.output() + status.out + restart.output());
    } finally { await f.stop(); }
  }, 30_000);

  test('compiled non-TTY apply cannot accept a scripted answer', async () => {
    const f = await fixture();
    try {
      const result = await f.piped(['setup', 'pair', '--apply'], 'yes\nPAIR 000000000000\n');
      expect(result.code).toBe(2);
      expect(result.out).toContain('No credential was created');
      expect(f.migrations()).toBe(0);
      expect(readAgentHostPairing(f.home, f.host).status).toBe('missing');
      f.assertPrivateOutput(result.out + result.error);
    } finally { await f.stop(); }
  }, 20_000);
});
