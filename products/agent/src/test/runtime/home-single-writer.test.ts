/**
 * home-single-writer.test.ts, one live agent per home.
 *
 * The gap this closes: a turn forked a SECOND full agent onto the home a live
 * agent was already running out of. Two processes then owned one
 * `.goodvibes/agent/` tree, two writers over the same session files, the same
 * state store, the same transcript, which is how a temp-file race killed a
 * process and how a ghost session was left marked "active" by a writer that no
 * longer existed. Nothing refused, because nothing was asking.
 *
 * The SDK owns the rule (`claimSurfaceHome`) and proves the rule itself. What
 * this proves is that the AGENT'S OWN composition asks for it: the agent is the
 * singleton surface, one per machine, holding one home, so it passes
 * `homeSingleWriter: 'claim'` where the terminal deliberately does not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootstrap as runtimeComposition } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const holders: ChildProcess[] = [];
const built: RuntimeServices[] = [];

/**
 * A process that is genuinely alive and genuinely some OTHER program, so the
 * liveness check has a real pid to read and a real argv to compare against. A
 * fabricated pid would be testing the fake: the identity half of the rule
 * exists precisely because it reads `/proc/<pid>/cmdline` for real.
 */
async function liveForeignProcess(): Promise<{ pid: number; identity: string }> {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  holders.push(child);
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('could not start a holder process');
  // `spawn` hands back a pid before the child has finished replacing itself
  // with `sleep`, and `/proc/<pid>/cmdline` is empty until it has. Waiting for
  // the argv is waiting for the holder to BE the program it claims to be,
  // reading it a moment too early is what made this flaky under a loaded run.
  const deadline = Date.now() + 10_000;
  let identity = runtimeComposition.readProcessIdentity(pid);
  while (identity === null && Date.now() < deadline) {
    await Bun.sleep(10);
    identity = runtimeComposition.readProcessIdentity(pid);
  }
  if (identity === null) throw new Error(`the holder pid ${pid} reported no identity`);
  return { pid, identity };
}

/** Boot the agent's real service composition rooted at this home. */
function bootAgentAt(home: string): RuntimeServices {
  const workingDir = join(home, 'work');
  mkdirSync(workingDir, { recursive: true });
  const services = createRuntimeServices({
    modelDiscovery: 'skip',
    configManager: new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(home, 'config'),
      workingDir,
      homeDir: home,
    }),
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    workingDir,
    homeDirectory: home,
    getConversationTitle: () => 'home-single-writer',
  });
  built.push(services);
  return services;
}

/** Put an owner record on a home, as a live first agent would have left it. */
function writeClaim(home: string, claim: { pid: number; identity: string }): void {
  const path = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...claim, claimedAt: Date.now() }), { mode: 0o600 });
}

/** Observe a missed refusal after it happens, without delaying the holder/boot race. */
function missedRefusalDetails(home: string, holder: { pid: number; identity: string }): string {
  const describeError = (error: unknown): object => ({
    name: error instanceof Error ? error.name : 'unknown',
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      && /^E[A-Z0-9_]+$/.test(error.code) ? error.code : undefined,
  });
  const inspect = (read: () => unknown): unknown => {
    try { return read(); }
    catch (error) { return describeError(error); }
  };
  // A recycled PID could point at an unrelated process. Never print raw argv.
  const describeIdentity = (identity: string | null): object | null => identity === null ? null : ({
    expectedSleep: identity === 'sleep 120',
    matchesRecorded: identity === holder.identity,
    matchesTestProcessProcIdentity: identity === runtimeComposition.readProcessIdentity(process.pid),
    matchesTestProcessClaimIdentity: identity === runtimeComposition.currentProcessIdentity(),
    sha256: createHash('sha256').update(identity).digest('hex'),
  });
  let liveness: string | object = 'alive';
  try { process.kill(holder.pid, 0); }
  catch (error) { liveness = describeError(error); }
  const child = holders.find((candidate) => candidate.pid === holder.pid);
  const claimPath = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
  return JSON.stringify({
    testPid: process.pid,
    expectedHolder: { pid: holder.pid, identity: describeIdentity(holder.identity) },
    liveness,
    identityNow: describeIdentity(runtimeComposition.readProcessIdentity(holder.pid)),
    cmdlineNow: inspect(() => describeIdentity(readFileSync(`/proc/${holder.pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ').slice(0, 512))),
    executableNow: inspect(() => ({ expectedSleep: readlinkSync(`/proc/${holder.pid}/exe`).endsWith('/sleep') })),
    claimPath,
    claimNow: inspect(() => {
      const value: unknown = JSON.parse(readFileSync(claimPath, 'utf-8'));
      if (typeof value !== 'object' || value === null) return { validRecord: false };
      const claim = value as Record<string, unknown>;
      return {
        pid: typeof claim.pid === 'number' && Number.isFinite(claim.pid) ? claim.pid : null,
        claimedAt: typeof claim.claimedAt === 'number' && Number.isFinite(claim.claimedAt) ? claim.claimedAt : null,
        isTestProcess: claim.pid === process.pid,
        identity: typeof claim.identity === 'string' ? describeIdentity(claim.identity) : null,
      };
    }),
    bootedHome: built.at(-1)?.shellPaths.homeDirectory,
    childExitCode: child?.exitCode,
    childSignalCode: child?.signalCode,
    childKilled: child?.killed,
  });
}

afterEach(() => {
  for (const services of built.splice(0)) {
    try {
      services.dispose();
    } catch {
      // A graph that never finished building has nothing to give back.
    }
  }
  for (const child of holders.splice(0)) child.kill('SIGKILL');
});

describe('a second agent booted onto a live agent\'s home', () => {
  test('is refused at boot, and the refusal names the pid that holds it', async () => {
    const home = makeProjectTempDir('agent-home-claim');
    const holder = await liveForeignProcess();
    writeClaim(home, holder);

    let refusal: unknown;
    try {
      bootAgentAt(home);
    } catch (error) {
      refusal = error;
    }

    expect(refusal, refusal === undefined ? missedRefusalDetails(home, holder) : undefined)
      .toBeInstanceOf(runtimeComposition.SurfaceHomeInUseError);
    const error = refusal as InstanceType<typeof runtimeComposition.SurfaceHomeInUseError>;
    // Naming the pid is the whole difference between a boot that stops for a
    // reason a person can act on and one that stops without saying why.
    expect(error.holderPid).toBe(holder.pid);
    expect(error.message).toContain(String(holder.pid));
  });

  test('a home nothing holds is claimed, and the record names THIS process', () => {
    const home = makeProjectTempDir('agent-home-free');

    const services = bootAgentAt(home);

    const claimPath = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
    const record = JSON.parse(readFileSync(claimPath, 'utf-8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
    expect(services.shellPaths.homeDirectory).toBe(home);
  });
});
