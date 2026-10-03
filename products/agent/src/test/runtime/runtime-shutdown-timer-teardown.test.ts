/**
 * runtime-shutdown-timer-teardown.test.ts, the graph must let go of its timers.
 *
 * `createRuntimeServices()` starts pollers while it composes: the config-file
 * watch, the fleet registry tick, the memory governor, the watcher registry,
 * the cross-session orchestration sweep, the orchestration snapshot writer's
 * reap, the push-subscription sweep, both knowledge schedulers' reconcile
 * timers, the spine keepalive, and the snapshot / append-only / consolidation
 * schedulers. Every one of those owners already had a `stop()` or `dispose()`;
 * nothing called them, because the graph had no disposal seam.
 *
 * Unlike the SDK, this fork composes no DaemonServer of its own, it hands its
 * graph to one via startHostServices, which passes `runtimeServices` in, so the
 * SDK's ownership rule deliberately leaves that graph alone. `dispose()` here is
 * the only thing that stops these, and this file is its proof.
 *
 * Measured on this file before the seam existed: composing the graph created 23
 * timers, and the fork's entire teardown (disposeSessionWriteLedger +
 * providerRegistry.stopWatching) left 18 live, 14 of them permanent. After: 0.
 *
 * Two properties are held down here, and they are different:
 *
 *  1. No poller survives dispose(). Measured the instant it returns, against
 *     the named set of modules that own repeating work. A poller is permanent,
 *     it never drains, so this is the assertion that proves the seam.
 *  2. Nothing at all survives shortly after. A handle owned by work genuinely
 *     in flight when dispose() was called is not a leak, but it must still end.
 *     This catches anything that merely looks transient and is not.
 *
 * The measurement runs in a SUBPROCESS (fixtures/runtime-shutdown-probe.ts).
 * It wraps the timer globals process-wide, so in-suite it counted whatever
 * other test files happened to have in flight, an MCP reconnect schedule, an
 * orchestrator-runner timeout, a knowledge cooperative-yield, and failed on
 * timers this graph never created. Isolation is what makes the numbers mean
 * what they say.
 *
 * KNOWN GAP, deliberately not papered over. The probe disposes only after
 * composition has quiesced, because KnowledgeScheduleService.dispose() clears
 * its timer map without setting a disposed flag: an initializeSchedules() still
 * in flight re-arms three bootstrap-schedule timers AFTER teardown ran. That is
 * an SDK-internal race this fork has no seam into, and it is reachable from the
 * short-lived CLI paths (cli/management.ts withRuntimeServices,
 * cli/bundle-command.ts) that compose the graph, answer one question and
 * dispose within milliseconds. The fix belongs beside the other owner fixes in
 * the SDK, as the same dispose-after-disposed guard createDisposalScope carries.
 */

import { beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ShutdownProbeReport } from '../fixtures/runtime-shutdown-probe.ts';

/**
 * Modules that own repeating work started by the runtime graph. A handle
 * attributed to any of these after dispose() is a poller that was never torn
 * down, the exact defect this file exists to prevent regressing.
 */
const POLLER_OWNERS = [
  'config/config-file-watcher',
  'runtime/fleet/registry',
  'runtime/memory/memory-governor',
  'watchers/registry',
  'sessions/orchestration/registry',
  'orchestration/persistence',
  'push/subscription-store',
  'state/store-snapshots',
  'runtime/retention/append-only-registry',
  'state/memory-consolidation-scheduler',
  'knowledge/scheduling',
  'agents/wrfc-controller',
  'runtime/session-spine/client',
] as const;

const PROBE = join(import.meta.dir, '..', 'fixtures', 'runtime-shutdown-probe.ts');

let report: ShutdownProbeReport;

beforeAll(async () => {
  const proc = Bun.spawn(['bun', 'run', PROBE], {
    cwd: join(import.meta.dir, '..', '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.split('\n').find((entry) => entry.startsWith('__PROBE__'));
  if (!line) {
    throw new Error(`shutdown probe produced no report (exit ${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  report = JSON.parse(line.slice('__PROBE__'.length)) as ShutdownProbeReport;
  // The probe's own drain budget is 10s; give the subprocess room above it so a
  // regression reads as the pollers that survived rather than as a timeout.
}, 120_000);

test('createRuntimeServices() actually starts timers: the measurement is not vacuous', () => {
  // Guards the false pass where the graph stopped composing anything and the
  // leak count reads zero for entirely the wrong reason.
  expect(report.created).toBeGreaterThan(10);
});

test('dispose() leaves no poller from the runtime graph still running', () => {
  const survivors = report.liveAtDispose.filter((entry) => POLLER_OWNERS.some((owner) => entry.includes(owner)));
  expect(survivors).toEqual([]);
});

test('every timer the graph started is gone once in-flight work settles', () => {
  expect(report.liveAfterDrain).toEqual([]);
});
