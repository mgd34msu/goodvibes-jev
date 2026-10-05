/** Real source/compiled entrypoints and a real paired daemon. Only external model/Jev replies are fixtures. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import type { NativeIntakeJournalRecord } from '../../runtime/native-conversation-intake-journal.ts';
import { isolatedEnv, makeHome, removeHome, startStubModel, type E2EHome } from '../e2e/harness.ts';
import { startE2ENativeHost } from '../e2e/native-host-fixture.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

export type HeadlessProduct = 'agent' | 'tui';
export const HEADLESS_PROMPT = 'please answer the e2e marmot question';
export const HEADLESS_REPLY = 'The native headless marmot answer is forty-two.';
const productsRoot = resolve(import.meta.dir, '../../../..');
const intakePrefix = '/api/work-ledger/intake/';
export interface WireRequest { readonly path: string; readonly body: unknown; }

/** Discard only the response, after the daemon has durably processed the request. */
function nativeDoor(upstream: string) {
  const requests: WireRequest[] = [];
  let lostPath: string | undefined;
  let heldPath: string | undefined;
  let held: Promise<void> | undefined;
  let release = () => {};
  let arrived = () => {};
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    const bytes = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    let body: unknown;
    try { body = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; } catch { body = undefined; }
    requests.push({ path: url.pathname, body });
    if (heldPath === url.pathname) { arrived(); await held; }
    const headers = new Headers(request.headers); headers.delete('host');
    const response = await fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers, body: bytes, redirect: 'manual' });
    if (lostPath === url.pathname) {
      lostPath = undefined;
      await response.arrayBuffer();
      // A malformed successful response cannot trigger automatic HTTP retries.
      return Response.json({ fixture: 'durable response acknowledgement lost' });
    }
    return new Response(response.body, { status: response.status, headers: response.headers });
  } });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`, requests,
    loseNext(operation: 'capture' | 'admit') { lostPath = `${intakePrefix}${operation}`; },
    holdNext(operation: 'get' | 'admit') {
      heldPath = `${intakePrefix}${operation}`;
      held = new Promise<void>(resolveHeld => { release = resolveHeld; });
      const entered = new Promise<void>(resolveArrived => { arrived = resolveArrived; });
      return { entered, release: () => { heldPath = undefined; release(); } };
    },
    async stop() { heldPath = undefined; release(); await server.stop(true); },
  };
}

export interface HeadlessOutput { readonly code: number; readonly stdout: string; readonly stderr: string; }
export interface NativeEnvelope {
  readonly ok: boolean;
  readonly response: string;
  readonly stopReason: string;
  readonly native: { readonly status: string; readonly result?: { readonly kind: string }; readonly request?: { readonly requestId: string; readonly inputId: string } };
}
export function readEnvelope(output: HeadlessOutput): NativeEnvelope {
  try { return JSON.parse(output.stdout) as NativeEnvelope; }
  catch { throw new Error(`Headless stdout was not one JSON result (exit ${output.code}).\nstdout: ${output.stdout.slice(0, 2000)}\nstdout bytes: ${Buffer.byteLength(output.stdout)}\nstderr: ${output.stderr.slice(0, 2000)}`); }
}

/** Override only the artifact, never replace main.ts with a test-only entrypoint. */
function command(product: HeadlessProduct): string[] {
  const binary = process.env[`GOODVIBES_HEADLESS_${product.toUpperCase()}_BINARY`];
  if (binary) {
    const path = resolve(binary);
    if (!existsSync(path)) throw new Error(`Requested ${product} headless binary does not exist: ${path}`);
    return [path];
  }
  if (process.env.GOODVIBES_HEADLESS_REQUIRE_BINARIES === '1') throw new Error(`Compiled proof requires GOODVIBES_HEADLESS_${product.toUpperCase()}_BINARY`);
  return [process.execPath, join(productsRoot, product, 'src/main.ts')];
}

export async function makeHeadlessFixture(product: HeadlessProduct, reply = HEADLESS_REPLY) {
  const model = startStubModel(() => ({ text: reply }));
  let home: E2EHome | undefined;
  let host: Awaited<ReturnType<typeof startE2ENativeHost>> | undefined;
  let door: ReturnType<typeof nativeDoor> | undefined;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  try {
    home = await makeHome(model);
    mkdirSync(join(home.root, 'tmp'), { recursive: true });
    // The two products keep separate provider/config state, but use the same fixture contract.
    const tuiRoot = join(home.home, '.goodvibes/tui');
    mkdirSync(tuiRoot, { recursive: true });
    cpSync(join(home.home, '.goodvibes/agent/providers'), join(tuiRoot, 'providers'), { recursive: true });
    cpSync(join(home.home, '.goodvibes/agent/settings.json'), join(tuiRoot, 'settings.json'));
    const tuiConfig = new ConfigManager({ homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    seedProviderMetadataCacheFixture({ configManager: tuiConfig, homeDirectory: home.home, workingDirectory: home.workspace, surfaceRoot: 'tui' });
    host = await startE2ENativeHost(home);
    door = nativeDoor(host.daemon.baseUrl);
    const pairedToken = host.env.GOODVIBES_CONNECTED_HOST_TOKEN;
    const setToken = (token: string) => writeFileSync(join(home!.daemonHome, 'operator-tokens.json'), JSON.stringify({ token, peerId: 'native-headless-fixture', createdAt: Date.now() }));
    setToken(pairedToken);
    writeFileSync(join(home.daemonHome, 'settings.json'), JSON.stringify({ controlPlane: {
      host: '127.0.0.1', port: Number(new URL(door.baseUrl).port), publicBaseUrl: door.baseUrl,
    } }));
    const env = isolatedEnv(home, {
      GOODVIBES_HOME: home.home, GOODVIBES_AGENT_HOME: home.home,
      GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD: '1',
      GOODVIBES_AGENT_RUNTIME_URL: door.baseUrl,
      GOODVIBES_CONNECTED_HOST_TOKEN: pairedToken,
    });
    const journalPath = join(home.home, '.goodvibes', product, 'native-work-submission.json.intake');
    const start = (args: readonly string[], token = pairedToken) => {
      setToken(token);
      const child = Bun.spawn([...command(product), ...args], { cwd: home!.workspace,
        env: { ...env, GOODVIBES_CONNECTED_HOST_TOKEN: token }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      children.add(child);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        .then(([stdout, stderr, code]) => {
          if (timedOut) throw new Error(`${product} real entrypoint exceeded 30s.\nstdout: ${stdout}\nstderr: ${stderr}`);
          return { stdout, stderr, code };
        }).finally(() => { clearTimeout(timer); children.delete(child); });
      return { output, interrupt: () => child.kill('SIGINT') };
    };
    return {
      product, home, host, door, model, pairedToken, journalPath, start,
      run: (args: readonly string[], token?: string) => start(args, token).output,
      journal: (): { readonly version: 1; readonly records: readonly NativeIntakeJournalRecord[] } => JSON.parse(readFileSync(journalPath, 'utf8')),
      captures: () => door!.requests.filter(request => request.path === `${intakePrefix}capture`).map(request => request.body as NativeConversationIntakeCaptureRequest),
      intakeCalls: (since = 0) => door!.requests.slice(since).filter(request => request.path.startsWith(intakePrefix)).map(request => request.path.slice(intakePrefix.length)),
      async close() {
        for (const child of children) child.kill('SIGKILL');
        await Promise.all([...children].map(child => child.exited));
        await door!.stop();
        try { await host!.stop(); } finally { model.stop(); removeHome(home!); }
      },
    };
  } catch (error) {
    await door?.stop();
    try { await host?.stop(); } finally { model.stop(); if (home) removeHome(home); }
    throw error;
  }
}
