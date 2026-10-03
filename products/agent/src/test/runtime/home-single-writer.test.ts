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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

async function waitForHolderIdentity(
  pid: number,
  expectedIdentity: string,
  readIdentity: (pid: number) => string | null = runtimeComposition.readProcessIdentity,
  now: () => number = Date.now,
): Promise<string> {
  const deadline = now() + 10_000;
  let identity = readIdentity(pid);
  while (identity !== expectedIdentity && now() < deadline) {
    await Bun.sleep(10);
    identity = readIdentity(pid);
  }
  if (identity !== expectedIdentity) throw new Error(`the holder pid ${pid} did not report expected identity ${expectedIdentity} before the deadline`);
  return identity;
}

/**
 * A process that is genuinely alive and genuinely some OTHER program, so the
 * liveness check has a real pid to read and a real argv to compare against. A
 * fabricated pid would be testing the fake: the identity half of the rule
 * exists precisely because it reads `/proc/<pid>/cmdline` for real.
 */
async function liveForeignProcess(): Promise<{ pid: number; identity: string }> {
  const command = 'sleep';
  const args = ['120'];
  const child = spawn(command, args, { stdio: 'ignore' });
  holders.push(child);
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('could not start a holder process');
  // Before exec finishes, /proc can be empty OR still contain the inherited
  // parent argv. Only the exact program/arguments we spawned establish readiness.
  // Recording that transient parent identity would correctly look stale at boot.
  const identity = await waitForHolderIdentity(pid, [command, ...args].join(' '));
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

describe('live holder identity readiness', () => {
  test('ignores inherited parent argv and empty transitions until the expected program appears', async () => {
    const identities = ['bun parent-agent-tests.ts', null, 'bun parent-agent-tests.ts', 'sleep 120'];
    const probedPids: number[] = [];
    const identity = await waitForHolderIdentity(4242, 'sleep 120', (pid) => {
      probedPids.push(pid);
      return identities.shift() ?? null;
    });
    expect(identity).toBe('sleep 120');
    expect(identities).toEqual([]);
    expect(probedPids).toEqual([4242, 4242, 4242, 4242]);
  });

  test('rejects a nonmatching nonempty identity at the existing deadline', async () => {
    let reads = 0;
    let clockReads = 0;
    await expect(waitForHolderIdentity(4242, 'sleep 120', () => {
      reads += 1;
      return 'bun parent-agent-tests.ts';
    }, () => clockReads++ * 10_000)).rejects.toThrow('did not report expected identity sleep 120');
    expect(reads).toBe(1);
  });
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

    expect(refusal).toBeInstanceOf(runtimeComposition.SurfaceHomeInUseError);
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
