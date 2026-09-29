/**
 * power-darwin-caffeinate.test.ts, the macOS power seam.
 *
 * createHostPowerSeam used to return the unavailable seam on macOS. The darwin
 * seam holds sleep inhibition with a caffeinate child (released by ending it,
 * self-ending with its owner through `-w`), reads the sleep and wake edges
 * from a `log stream` ndjson watcher, and reaps a dead owner's watcher. Every
 * child here is a fake, so the suite runs on any host.
 */
import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  caffeinateArgs,
  createDarwinCaffeinateSeam,
  darwinSleepEdgeFromLogLine,
  parsePmsetPowerSource,
  reapOrphanedDarwinSleepWatchers,
  sleepWatchArgs,
  type DarwinPowerSource,
} from '../sdk/src/platform/power/darwin-caffeinate.ts';
import { createHostPowerSeam } from '../sdk/src/platform/power/runtime-wiring.ts';
import { PowerManager, LID_SWITCH_HONEST_SPLIT } from '../sdk/src/platform/power/manager.ts';

interface FakeChild {
  readonly child: ChildProcess;
  feed(text: string): void;
  exit(code: number): void;
  killed(): boolean;
}

function fakeChild(pid = 515151): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  let killed = false;
  const child = emitter as unknown as ChildProcess;
  const fields = child as unknown as { stdout: EventEmitter; unref: () => void; kill: () => boolean; pid: number; exitCode: number | null };
  fields.stdout = stdout;
  fields.unref = () => {};
  fields.pid = pid;
  fields.exitCode = null;
  fields.kill = () => {
    killed = true;
    fields.exitCode = 0;
    emitter.emit('exit', 0);
    return true;
  };
  return {
    child,
    feed: (text) => stdout.emit('data', Buffer.from(text, 'utf-8')),
    exit: (code) => {
      fields.exitCode = code;
      emitter.emit('exit', code);
    },
    killed: () => killed,
  };
}

function seamWith(source: DarwinPowerSource) {
  const spawns: Array<{ command: string; args: readonly string[]; fake: FakeChild }> = [];
  const seam = createDarwinCaffeinateSeam({
    startProbeMs: 5,
    readPowerSource: async () => source,
    fileExists: (path) => path === '/usr/bin/caffeinate',
    spawnInhibitor: (command, args) => {
      const fake = fakeChild();
      spawns.push({ command, args, fake });
      return fake.child;
    },
  });
  return { seam, spawns };
}

describe('createHostPowerSeam on macOS', () => {
  test('darwin selects the caffeinate seam, not the unavailable seam', async () => {
    const seam = createHostPowerSeam('darwin');
    expect(seam.platform).toBe('darwin-caffeinate');
    expect(typeof seam.onPrepareForSleep).toBe('function');
    expect(typeof seam.reapOrphans).toBe('function');
    expect(createHostPowerSeam('win32').platform).toBe('unavailable (no power seam for win32)');
  });
});

describe('caffeinate inhibition', () => {
  test('idle + sleep on AC power spawn one caffeinate -i -s -w <owner pid>; release ends the child', async () => {
    const { seam, spawns } = seamWith('ac');
    expect(await seam.isAvailable()).toBe(true);
    const handle = await seam.inhibit({ classes: ['idle', 'sleep'], who: 'goodvibes', why: 'turn running' });
    expect(handle).not.toBeNull();
    expect(handle!.grantedClasses).toEqual(['idle', 'sleep']);
    expect(handle!.deniedClasses).toEqual([]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe('/usr/bin/caffeinate');
    expect(spawns[0]!.args).toEqual(['-i', '-s', '-w', String(process.pid)]);
    await handle!.release();
    expect(spawns[0]!.fake.killed()).toBe(true);
  });

  test('on battery the sleep class is honestly denied (the -s flag is still held for AC); lid-switch is always denied', async () => {
    const { seam, spawns } = seamWith('battery');
    const handle = await seam.inhibit({ classes: ['idle', 'sleep', 'handle-lid-switch'], who: 'goodvibes', why: 'keep awake' });
    expect(handle!.grantedClasses).toEqual(['idle']);
    expect(handle!.deniedClasses).toEqual(['sleep', 'handle-lid-switch']);
    expect(spawns[0]!.args).toEqual(['-i', '-s', '-w', String(process.pid)]);
    await handle!.release();
  });

  test('nothing grantable spawns nothing and returns null', async () => {
    const { seam, spawns } = seamWith('ac');
    expect(await seam.inhibit({ classes: ['handle-lid-switch'], who: 'goodvibes', why: 'x' })).toBeNull();
    expect(spawns).toHaveLength(0);
  });

  test('a caffeinate child that exits during the start probe is a refusal', async () => {
    const seam = createDarwinCaffeinateSeam({
      startProbeMs: 20,
      readPowerSource: async () => 'ac',
      spawnInhibitor: () => {
        const fake = fakeChild();
        queueMicrotask(() => fake.exit(1));
        return fake.child;
      },
    });
    expect(await seam.inhibit({ classes: ['idle'], who: 'goodvibes', why: 'x' })).toBeNull();
  });

  test('the PowerManager serves the honest lid-switch split through this seam', async () => {
    const { seam } = seamWith('ac');
    const manager = new PowerManager({ seam, registerProcessExitHooks: () => () => undefined, readConfig: () => undefined, writeConfig: () => {} });
    await manager.setKeepAwake(true, { persist: false });
    const state = manager.getState();
    expect(state.keepAwake.held).toBe(true);
    expect(state.keepAwake.deniedClasses).toEqual(['handle-lid-switch']);
    expect(state.keepAwake.note).toBe(LID_SWITCH_HONEST_SPLIT);
    await manager.stop();
  });

  test('caffeinateArgs dedupes flags and always ends with the owner wait', () => {
    expect(caffeinateArgs(['idle', 'idle', 'handle-lid-switch'], 42)).toEqual(['-i', '-w', '42']);
  });

  test('pmset -g ps first line maps to the power source', () => {
    expect(parsePmsetPowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toBe('ac');
    expect(parsePmsetPowerSource("Now drawing from 'Battery Power'\n")).toBe('battery');
    expect(parsePmsetPowerSource("Now drawing from 'UPS Power'\n")).toBe('other');
    expect(parsePmsetPowerSource('')).toBe('unknown');
  });
});

describe('the log stream sleep-edge watcher', () => {
  test('spawns a stamped ndjson kernel watcher, fires one edge per transition line, and the unsubscribe ends it', () => {
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    let fake!: FakeChild;
    const seam = createDarwinCaffeinateSeam({
      spawnMonitor: (command, args) => {
        spawns.push({ command, args });
        fake = fakeChild(626262);
        return fake.child;
      },
    });
    const edges: boolean[] = [];
    const unsubscribe = seam.onPrepareForSleep!((sleeping) => edges.push(sleeping));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe('/usr/bin/log');
    expect(spawns[0]!.args).toEqual(sleepWatchArgs(process.pid));
    expect(spawns[0]!.args.slice(0, 3)).toEqual(['stream', '--style', 'ndjson']);
    expect(spawns[0]!.args[4]).toContain('process == "kernel"');
    expect(spawns[0]!.args[4]).toContain(`GoodvibesSleepWatchOwner${process.pid}`);

    const entry = (message: string) => JSON.stringify({ process: 'kernel', eventMessage: message });
    fake.feed('Filtering the log data using "process == \\"kernel\\""\n');
    fake.feed(`${entry('PMRD: System Sleep')}\n${entry('Wake reason: EC.LidOpen')}\n`);
    expect(edges).toEqual([true]);
    // A line split across two chunks is read once, whole.
    const wake = entry('System Wake');
    fake.feed(wake.slice(0, 10));
    expect(edges).toEqual([true]);
    fake.feed(`${wake.slice(10)}\n`);
    expect(edges).toEqual([true, false]);
    fake.feed(`${entry('System SafeSleep')}\n${entry('System SafeSleep Wake')}\n`);
    expect(edges).toEqual([true, false, true, false]);

    unsubscribe();
    expect(fake.killed()).toBe(true);
  });

  test('non-transition kernel lines never fire an edge', () => {
    expect(darwinSleepEdgeFromLogLine(JSON.stringify({ eventMessage: 'System Shutdown requested' }))).toBeNull();
    expect(darwinSleepEdgeFromLogLine(JSON.stringify({ eventMessage: 'DarkWake from Deep Idle' }))).toBeNull();
    expect(darwinSleepEdgeFromLogLine('{not json')).toBeNull();
    expect(darwinSleepEdgeFromLogLine(JSON.stringify({ eventMessage: 42 }))).toBeNull();
  });

  test('the reaper ends a dead owner\'s stamped watcher and never a live owner\'s or an unstamped log stream', async () => {
    const killed: number[] = [];
    const reaped = await reapOrphanedDarwinSleepWatchers({
      listProcesses: () => [
        { pid: 701, args: `/usr/bin/log ${sleepWatchArgs(41).join(' ')}` },
        { pid: 702, args: `/usr/bin/log ${sleepWatchArgs(43).join(' ')}` },
        { pid: 703, args: '/usr/bin/log stream --predicate process == "kernel"' },
        { pid: 704, args: `/usr/bin/caffeinate -i -w 41` },
      ],
      isAlive: (pid) => pid === 43,
      kill: (pid) => { killed.push(pid); },
      selfPid: 1000,
    });
    expect(reaped).toBe(1);
    expect(killed).toEqual([701]);
  });
});
