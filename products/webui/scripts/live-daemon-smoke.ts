/**
 * live-daemon-smoke.ts, exercise the webui's own transport + stream code against a REAL
 * daemon process, not mocks.
 *
 * WHY A SEPARATE LANE: the default `bun test` unit lane is hermetic (happy-dom + in-page
 * mocks) and must stay that way. This lane boots a real daemon from the local SDK dev-link
 * (bootDaemon: isolated home, ephemeral loopback port, bearer-token auth), points the
 * webui's actual SDK client (src/lib/goodvibes.ts) at it, and drives a minimal session
 * round-trip end to end, proving the real request/response and Server-Sent-Event paths
 * work against a genuine daemon. It is wired as `bun run test:live`, NOT under the default
 * test glob, so the unit lane never spawns a process.
 *
 * It is deliberately model-free: it creates and lists a session and opens the live event
 * stream (all real daemon state), so it needs no provider credential and runs green offline.
 * Sending a message that requires an LLM turn is out of scope here precisely because that
 * WOULD need an external credential.
 *
 * Run: `bun run test:live`  (or `bun run scripts/live-daemon-smoke.ts`)
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@goodvibes-jev/engine/sdk/daemon';
import { installTestTempRoot, sweepStaleRunRoots } from './test-temp-root';
import { requireSessionCloseReceipt } from './live-daemon-lifecycle';

// The webui token store (createBrowserTokenStore) persists to localStorage. In this headless
// lane there is no browser, so provide a minimal in-memory localStorage BEFORE importing the
// webui client (which constructs the token store at module evaluation).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const TOKEN = 'live-smoke-bearer-token';
const SESSION_TITLE = `live-smoke-${Date.now()}`;

function log(step: string): void {
  process.stdout.write(`  • ${step}\n`);
}

function sessionId(value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>;
  const direct = record.sessionId ?? record.id;
  if (typeof direct === 'string' && direct) return direct;
  const nested = (record.session ?? {}) as Record<string, unknown>;
  const inner = nested.sessionId ?? nested.id;
  return typeof inner === 'string' ? inner : '';
}

function sessionsFrom(value: unknown): Record<string, unknown>[] {
  const record = (value ?? {}) as Record<string, unknown>;
  const list = Array.isArray(record.sessions) ? record.sessions : Array.isArray(value) ? value : [];
  return list.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

/**
 * Scratch space for this lane.
 *
 * This lane boots a REAL daemon with its own home directory, so what it creates
 * is not a couple of empty directories, it is a full daemon tree. It used to
 * put both under the system temp directory, cleaned by a `finally` block. That
 * covers a run that finishes (pass or fail) and nothing else: interrupt it with
 * Ctrl-C or let CI time it out and both trees stayed in the system temp with
 * nobody to remove them.
 *
 * Now both live under one parent inside the repo's gitignored `.test-tmp/run-<pid>`.
 * Three things remove it, in descending order of reliability:
 *   1. scripts/live-daemon-smoke-runner.ts, the parent `bun run test:live` starts,
 *      deterministic, because it deletes after THIS process has fully exited;
 *   2. the in-process cleanup below (SIGINT/SIGTERM, and an exit handler), best
 *      effort, and measured to lose a race against the daemon's teardown flush;
 *   3. sweepStaleRunRoots() at the start of the next test run, which reaps any
 *      root whose owning pid is gone.
 * One parent directory instead of two siblings also means a failure BETWEEN the
 * two creations can no longer strand the first one.
 *
 * ROOTING A REAL-DAEMON SCRATCH TREE INSIDE THE CHECKOUT IS NOT FREE, and was
 * checked rather than assumed. goodvibes-sdk's own repo hit a real bug from the
 * same move: a tool walked upward from an in-repo test fixture looking for
 * `tsconfig.json`, found the REAL repo's tsconfig sitting above it instead of
 * finding none, and corrupted that test's expectations. Why that cannot happen
 * here:
 *   - ConfigManager (@pellux/goodvibes-sdk dist/platform/config/manager.js)
 *     builds settings.json paths by joining directly under the given
 *     workingDir/homeDirectory. It never walks upward.
 *   - Nothing in bootDaemon's construction/start path (dist/platform/daemon/
 *     boot.js, facade.js, facade-composition.js) calls `detectProject`
 *     (dist/platform/tools/inspect/project.js, the function that reads
 *     package.json/tsconfig.json). That function is reached only from the
 *     "inspect project" agent tool's executor, and this smoke is deliberately
 *     model-free: it never drives an agent turn, a tool call, or a hook.
 *   - Measured against the real (unlinked, npm) package: the only file the
 *     daemon wrote under the scratch dir was its own
 *     `.goodvibes/logs/activity.md`.
 * The third bullet is what makes the in-repo root safe TODAY. If this smoke
 * ever starts driving real tool or hook invocations, it reaches the
 * upward-walking path and this decision has to be re-made, that is the one
 * change to this file that must not be waved through.
 */
const RUN_ROOT = installTestTempRoot();

function removeRunRoot(): void {
  rmSync(RUN_ROOT, { recursive: true, force: true });
}

/**
 * Remove the scratch tree and try to keep it removed.
 *
 * Measured, not assumed: a single rmSync in the `finally` block left
 * `workdir/.goodvibes/logs/activity.md` on disk on every run, the daemon's
 * activity logger still has writes in flight when stop() resolves, and the
 * writer mkdir -p's its way back into the directory just deleted. Repeating
 * until the tree stays gone across consecutive observations shrinks that window
 * but does NOT close it (also measured: still 3 of 3 runs leaked). The
 * deterministic cleanup is the parent process in
 * scripts/live-daemon-smoke-runner.ts; this is the in-process best effort.
 */
async function removeRunRootSettled(): Promise<void> {
  // Deleting once and checking once is what failed: the tree was gone at the
  // check and back by process exit. Require it to STAY gone across consecutive
  // observations, so a flush still in flight gets deleted rather than winning
  // the race after the last look.
  let consecutiveClean = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(RUN_ROOT)) {
      removeRunRoot();
      consecutiveClean = 0;
    } else {
      consecutiveClean += 1;
      if (consecutiveClean >= 3) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  removeRunRoot();
}

async function main(): Promise<void> {
  sweepStaleRunRoots();
  const home = join(RUN_ROOT, 'daemon-home');
  const work = join(RUN_ROOT, 'workdir');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  let daemon: BootedDaemon | null = null;

  // An interrupted run must not strand a daemon tree. Ctrl-C and a CI timeout
  // kill arrive as signals; without a handler the process dies before any
  // `finally` or exit hook gets to remove the tree, which is the interrupt case
  // the original code had no answer for at all.
  const onSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      try {
        if (daemon) await daemon.stop();
      } finally {
        await removeRunRootSettled();
        process.stderr.write(`\nLive-daemon smoke: interrupted by ${signal}; scratch removed\n`);
        process.exit(130);
      }
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    process.stdout.write('Live-daemon smoke\n');
    // The daemon eagerly constructs its builtin model providers at boot, and some provider
    // SDKs (e.g. OpenAI) refuse to even CONSTRUCT without an api key present. This lane never
    // makes a model call, it only exercises sessions + streaming, so a placeholder key that
    // satisfies construction is honest here: no request is ever sent to any provider.
    for (const key of ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY']) {
      if (!process.env[key]) process.env[key] = 'live-smoke-placeholder-unused';
    }
    log('booting a real daemon (isolated home, ephemeral loopback port)…');
    daemon = await bootDaemon({ homeDirectory: home, workingDir: work, port: 0, token: TOKEN });
    log(`daemon up at ${daemon.url}`);

    // Point the webui's SDK client at the real daemon, THEN import it (it reads the base URL
    // at module evaluation). A loopback http origin is a secure context, so the SDK transport
    // guard does not fire.
    process.env.VITE_GOODVIBES_BASE_URL = daemon.url;
    const { sdk } = await import('../src/lib/goodvibes');
    const { SESSION_UPDATE_WIRE_EVENT } = await import('../src/lib/sessions-union');
    await sdk.auth.setToken(TOKEN);

    // 1) A real authenticated request/response round-trip through the webui client.
    log('control.status round-trip…');
    const status = await sdk.operator.control.status();
    assert.ok(status && typeof status === 'object', 'control.status returned a snapshot object');

    // 2) A real mutating round-trip: create a session, then read it back from the list.
    log('creating a session…');
    const created = await sdk.operator.invoke('sessions.create', { title: SESSION_TITLE });
    const createdId = sessionId(created);
    assert.ok(createdId, 'sessions.create returned a session id');

    log('listing sessions and asserting the new one is present…');
    const listed = await sdk.operator.invoke('sessions.list', {});
    const found = sessionsFrom(listed).some((entry) => sessionId(entry) === createdId);
    assert.ok(found, `the created session (${createdId}) appears in the real daemon's session list`);

    // 3) Real streamed state: open the live control-plane SSE against the daemon and assert
    //    the stream genuinely opens (onReady from a real process, over Bun's streaming fetch).
    //    Require the close response AND its matching session-update frame within the window.
    log('opening the live event stream and driving a mutation…');
    await requireSessionCloseReceipt({
      sessionId: createdId,
      eventName: SESSION_UPDATE_WIRE_EVENT,
      close: () => sdk.operator.invoke('sessions.close', { sessionId: createdId }),
      open: (handlers) => sdk.streams.open(
        '/api/control-plane/events?domains=session',
        handlers,
        { reconnect: { enabled: false, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, maxAttempts: 0 } },
      ),
    });
    log('close acknowledged and matching closed-session frame received over the live stream');

    process.stdout.write('\nLive-daemon smoke: PASS\n');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (daemon) await daemon.stop();
  }
}

/**
 * The in-process removal happens after main() has fully settled rather than
 * inside its `finally`, which narrows the window the daemon's teardown flush can
 * use, but does not eliminate it. Measured: the tree was still on disk after
 * 3 of 3 runs with the removal here. The runner process is what makes it zero.
 */
async function finish(code: number): Promise<never> {
  await removeRunRootSettled();
  process.exit(code);
}

/**
 * Best-effort last word from inside this process. It is NOT what closes the
 * leak, measured: with only this in place the tree was still on disk after
 * 3 of 3 runs, because the daemon's activity log is flushed during teardown at
 * a point this handler cannot reliably follow. `bun run scripts/
 * live-daemon-smoke-runner.ts` (what `bun run test:live` invokes) is the
 * deterministic cleanup: it removes the run root from a PARENT process, after
 * this one has fully exited and nothing is left that could write.
 *
 * Kept anyway for the case where someone runs this file directly, and because
 * exit handlers DO fire under `bun run` (they do not under `bun test`, which is
 * why the unit lane's cleanup is built on the preload + sweep instead).
 */
process.on('exit', () => {
  removeRunRoot();
});

main().then(
  () => finish(0),
  (error: unknown) => {
    process.stderr.write(`\nLive-daemon smoke: FAIL\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return finish(1);
  },
);
