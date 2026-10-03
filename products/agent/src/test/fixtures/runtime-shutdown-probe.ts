/**
 * runtime-shutdown-probe.ts, the measurement half of
 * src/test/runtime/runtime-shutdown-timer-teardown.test.ts.
 *
 * Not a test file (the suite runner collects only *.test.ts). It runs as its
 * OWN process, and that isolation is the whole point: the measurement wraps the
 * timer globals process-wide, so anything else running in the same process gets
 * counted. Measured in-suite, this probe attributed an MCP reconnect schedule,
 * an orchestrator-runner timeout and a knowledge cooperative-yield to the graph
 * under test, all of them in-flight async work left over from earlier test
 * files, none of them composed here. A subprocess has no such neighbours.
 *
 * Composes the runtime graph, lets composition quiesce, disposes it, and prints
 * one JSON line describing every timer still live. The parent asserts.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from '@/config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '@/config/surface.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '@/runtime/store/index.ts';
import { createRuntimeServices } from '@/runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** What the parent test asserts on. */
export interface ShutdownProbeReport {
  /** Timers created across the whole compose→dispose window. */
  readonly created: number;
  /** Still live the instant dispose() returned, plus a microtask grace. */
  readonly liveAtDispose: readonly string[];
  /** Still live after in-flight work was given a bounded chance to finish. */
  readonly liveAfterDrain: readonly string[];
}

interface TrackedTimer {
  readonly kind: 'interval' | 'timeout';
  readonly delayMs: number;
  readonly stack: string;
}

const live = new Map<unknown, TrackedTimer>();
let created = 0;

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;

/**
 * One-shot timeouts are tracked as well as intervals, because a `setTimeout`
 * that reschedules itself is a poller wearing a different hat, three of the
 * graph's schedulers are exactly that. A timeout leaves the live set when it
 * fires, so an ordinary elapsed sleep never counts as still-live.
 */
function installTimerTracking(): void {
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetInterval(fn as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'interval', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => {
      live.delete(handle);
      (fn as (...x: unknown[]) => void)(...a);
    };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'timeout', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearInterval = ((handle: never) => {
    live.delete(handle);
    return realClearInterval(handle);
  }) as typeof globalThis.clearInterval;
  globalThis.clearTimeout = ((handle: never) => {
    live.delete(handle);
    return realClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
}

/** The frame that made the timer, the field that names what still needs disposing. */
function siteOf(stack: string): string {
  for (const line of stack.split('\n').slice(2)) {
    const match = /([^\s()]+\.(?:ts|tsx|js|mjs)):\d+:\d+/.exec(line);
    if (!match) continue;
    if (/runtime-shutdown-probe|node:internal/.test(line)) continue;
    const fn = /at\s+(?:async\s+)?([^\s(]+)\s*\(/.exec(line)?.[1] ?? '';
    // Normalize this repo's own frames and the SDK package's compiled frames
    // down to the module path that names the owner.
    const file = match[1]
      .replace(/^.*\/@pellux\/goodvibes-sdk\/dist\//, 'sdk/')
      .replace(/^.*\/packages\/sdk\/dist\//, 'sdk/')
      .replace(/^.*\/@pellux\/goodvibes-terminal-shell\/dist\//, 'terminal-shell/')
      .replace(/^.*\/packages\/terminal-shell\/dist\//, 'terminal-shell/')
      .replace(/^.*\/src\//, 'src/');
    return fn ? `${fn} (${file})` : file;
  }
  return '<unknown site>';
}

function describeLive(): string[] {
  return [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`).sort();
}

async function main(): Promise<void> {
  const home = makeProjectTempDir('agent-shutdown-home');
  const work = makeProjectTempDir('agent-shutdown-work');

  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(home, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: work,
    homeDir: home,
  });
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();

  installTimerTracking();
  const services = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
    configManager,
    runtimeBus,
    runtimeStore,
    workingDir: work,
    homeDirectory: home,
  });

  // Let composition FINISH before tearing it down. createRuntimeServices() is
  // synchronous, but some owners arm their timers from an async continuation
  // (the knowledge scheduler awaits store.init() and three schedule upserts
  // before reconcileSchedules() arms anything), so disposing the instant the
  // call returns measures a half-built graph rather than the seam. Quiescence
  // is detected rather than slept through: poll until no new timer has been
  // created for three consecutive samples.
  let stable = 0;
  let lastCreated = -1;
  const settleDeadline = Date.now() + 15_000;
  while (stable < 3 && Date.now() < settleDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 100));
    stable = created === lastCreated ? stable + 1 : 0;
    lastCreated = created;
  }

  services.dispose();

  // A microtask grace only: teardown that lands on an `await` chain has run,
  // but nothing has had time to *drain*. This is the strict snapshot.
  await new Promise((resolve) => realSetTimeout(resolve, 50));
  const report: ShutdownProbeReport = {
    created,
    liveAtDispose: describeLive(),
    liveAfterDrain: [],
  };

  // Then give in-flight work a bounded chance to finish. Polling rather than
  // one long sleep so the probe costs what it needs and no more.
  const drainDeadline = Date.now() + 10_000;
  while (live.size > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 50));
  }

  console.log(`__PROBE__${JSON.stringify({ ...report, liveAfterDrain: describeLive() })}`);

  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  // Explicit: a graph that failed to let go would otherwise hold this process
  // open, and a hang reads far worse than the report that names the survivors.
  process.exit(0);
}

await main();
