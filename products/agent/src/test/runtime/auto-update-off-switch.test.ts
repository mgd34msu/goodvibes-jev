import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { readExplicitUpdateKeys, readUpdateSettings } from '../../config/update-settings.ts';
import { runLaunchAutoUpdate } from '../../cli/launch-auto-update.ts';
import { AgentPeriodicUpdater, periodicUpdateEnabled } from '../../runtime/periodic-update.ts';
import {
  describeSelfUpdate,
  readLastSelfUpdate,
  recordSelfUpdate,
  selfUpdateLogPath,
  type SelfUpdateReceiptIo,
} from '../../runtime/self-update-receipt.ts';
import { renderGoodVibesVersion } from '../../cli/help.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * The documented off switch, pinned end to end.
 *
 * A compiled 1.18.1 binary with `update.autoUpdateAtLaunch: false` in the
 * documented user-level file replaced itself with the published 1.19.0 anyway
 * and left a `goodvibes-agent.previous` beside it. The switch stopped the
 * launch swap and nothing else: the while-running updater carried its own
 * default-on `update.auto` and swapped the binary about thirty seconds in.
 *
 * That is worse than a missing feature. It silently invalidates verification,
 * any check run against that binary was measuring a published release rather
 * than the build under test, and the only evidence was a leftover file.
 *
 * These tests drive the REAL ConfigManager against real settings files, so a
 * regression in config scope, precedence, or either updater's gate fails here.
 */

const scratchDirs: string[] = [];

function scratch(): { home: string; work: string } {
  const root = makeProjectTempDir('gv-offswitch');
  scratchDirs.push(root);
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { home, work };
}

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Writes `<base>/.goodvibes/agent/settings.json`, the surface's settings file. */
function writeSettings(base: string, update: Record<string, unknown>): void {
  const dir = join(base, '.goodvibes', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ update }, null, 2), 'utf-8');
}

/** A release feed that always reports a newer version, so nothing but the switch can stop an update. */
const NEWER_RELEASE_AVAILABLE = (async (url: string) => {
  if (String(url).endsWith('/releases/latest')) {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/mgd34msu/goodvibes-agent/releases/tag/v1.19.0' },
    });
  }
  return new Response(null, { status: 404 });
}) as never;

/** A path detectInstallKind classifies as a compiled release binary. */
const BINARY_EXEC_PATH = '/home/someone/.local/bin/goodvibes-agent';

function managerFor(home: string, work: string): ConfigManager {
  return new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'agent' });
}

function settingsFrom(home: string, work: string): ReturnType<typeof readUpdateSettings> {
  return readUpdateSettings(managerFor(home, work));
}

/**
 * Whether the while-running updater is armed, resolved exactly the way
 * startPeriodicSelfUpdate resolves it, including reading which keys the person
 * actually stated. A helper that skipped that would test a gate the product
 * does not use.
 */
function periodicArmed(home: string, work: string): boolean {
  const manager = managerFor(home, work);
  return periodicUpdateEnabled(readUpdateSettings(manager), {
    autoWasStated: readExplicitUpdateKeys(manager).has('auto'),
  });
}

/** Runs the launch updater and reports whether it swapped the binary. */
async function launchWouldSwap(settings: ReturnType<typeof readUpdateSettings>): Promise<boolean> {
  let swapped = false;
  await runLaunchAutoUpdate({
    fetchImpl: NEWER_RELEASE_AVAILABLE,
    execPath: BINARY_EXEC_PATH,
    platform: 'linux',
    arch: 'x64',
    currentVersion: '1.18.1',
    settings,
    env: {},
    print: () => {},
    apply: async () => {
      swapped = true;
    },
    recordReceipt: () => {},
  });
  return swapped;
}

/** Drives one full periodic tick and reports whether it swapped the binary. */
async function periodicWouldSwap(home: string, work: string): Promise<boolean> {
  if (!periodicArmed(home, work)) return false;
  const settings = readUpdateSettings(managerFor(home, work));
  let swapped = false;
  const updater = new AgentPeriodicUpdater({
    currentVersion: '1.18.1',
    execPath: BINARY_EXEC_PATH,
    platform: 'linux',
    arch: 'x64',
    settings,
    isIdle: () => true,
    notify: () => {},
    restartNow: () => {},
    fetchImpl: NEWER_RELEASE_AVAILABLE,
    apply: async () => {
      swapped = true;
    },
    recordReceipt: () => {},
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  await updater.tick();
  return swapped;
}

describe('update.autoUpdateAtLaunch: false stops a compiled binary replacing itself', () => {
  test('the documented user-level file turns BOTH updaters off', async () => {
    // The exact reported case: ~/.goodvibes/agent/settings.json, nothing else.
    const { home, work } = scratch();
    writeSettings(home, { autoUpdateAtLaunch: false });
    const settings = settingsFrom(home, work);

    expect(settings.autoUpdateAtLaunch, 'the documented location must reach the reader').toBe(false);
    expect(await launchWouldSwap(settings), 'the launch updater must not swap the binary').toBe(false);
    // This is the assertion the shipped build failed: the periodic updater
    // carried its own default-on switch and swapped the binary ~30s in.
    expect(await periodicWouldSwap(home, work), 'the while-running updater must not swap the binary either').toBe(false);
  });

  test('a working-directory file behaves exactly like the user-level one', async () => {
    // The scope theory this bug was first attributed to. Both scopes reach the
    // reader; pinning it stops a real scope regression from hiding behind it.
    const { home, work } = scratch();
    writeSettings(work, { autoUpdateAtLaunch: false });
    const settings = settingsFrom(home, work);

    expect(settings.autoUpdateAtLaunch).toBe(false);
    expect(await launchWouldSwap(settings)).toBe(false);
    expect(await periodicWouldSwap(home, work)).toBe(false);
  });

  test('a working-directory file overrides the user-level one, in both directions', () => {
    const { home, work } = scratch();
    writeSettings(home, { autoUpdateAtLaunch: false });
    writeSettings(work, { autoUpdateAtLaunch: true });
    expect(settingsFrom(home, work).autoUpdateAtLaunch, 'project wins over user-level').toBe(true);

    const other = scratch();
    writeSettings(other.home, { autoUpdateAtLaunch: true });
    writeSettings(other.work, { autoUpdateAtLaunch: false });
    expect(settingsFrom(other.home, other.work).autoUpdateAtLaunch).toBe(false);
  });

  test('with no setting at all, a binary still updates itself: the default is unchanged', async () => {
    const { home, work } = scratch();
    const settings = settingsFrom(home, work);

    expect(settings.autoUpdateAtLaunch).toBeUndefined();
    expect(await launchWouldSwap(settings), 'default stays ON').toBe(true);
    expect(periodicArmed(home, work), 'default stays ON').toBe(true);
  });

  test('an explicit update.auto still wins, so launch-off-but-running-on stays expressible', async () => {
    const { home, work } = scratch();
    writeSettings(home, { autoUpdateAtLaunch: false, auto: true });
    const settings = settingsFrom(home, work);

    expect(await launchWouldSwap(settings), 'launch stays off').toBe(false);
    expect(await periodicWouldSwap(home, work), 'the stated while-running update still runs').toBe(true);
  });

  test('a reader with no access to the files reports nothing stated, keeping the off switch in force', () => {
    // The degrade direction is deliberate: unable to tell what was stated, the
    // documented switch governs, so an off switch is honored rather than
    // quietly overridden by a default.
    expect(readExplicitUpdateKeys({}).size).toBe(0);
    expect(periodicUpdateEnabled({ autoUpdateAtLaunch: false, auto: true }, { autoWasStated: false })).toBe(false);
  });

  test('update.auto: false alone still stops only the while-running updater', async () => {
    // The two settings remain independent features; this is the other half.
    const { home, work } = scratch();
    writeSettings(home, { auto: false });
    const settings = settingsFrom(home, work);

    expect(periodicArmed(home, work)).toBe(false);
    expect(await launchWouldSwap(settings), 'update.auto does not govern the launch swap').toBe(true);
  });
});

describe('a binary that replaces itself says so afterwards', () => {
  function memoryIo(): { io: SelfUpdateReceiptIo; store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      io: {
        append: (path, line) => store.set(path, (store.get(path) ?? '') + line),
        read: (path) => store.get(path) ?? null,
      },
    };
  }

  test('the launch swap writes a durable receipt beside the executable', async () => {
    const { io, store } = memoryIo();
    let recorded = false;
    await runLaunchAutoUpdate({
      fetchImpl: NEWER_RELEASE_AVAILABLE,
      execPath: BINARY_EXEC_PATH,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.18.1',
      settings: {},
      env: {},
      print: () => {},
      apply: async () => {},
      recordReceipt: (entry) => {
        recorded = true;
        recordSelfUpdate({ ...entry, now: () => new Date('2026-07-27T12:00:00.000Z') }, io);
      },
    });

    expect(recorded).toBe(true);
    expect(store.has(selfUpdateLogPath(BINARY_EXEC_PATH)), 'the receipt sits beside the binary').toBe(true);
    const receipt = readLastSelfUpdate(BINARY_EXEC_PATH, io);
    expect(receipt).toEqual({
      at: '2026-07-27T12:00:00.000Z',
      fromVersion: '1.18.1',
      toVersion: '1.19.0',
      trigger: 'launch',
    });
  });

  test('every replacement is kept, so a chain of swaps is still answerable', () => {
    const { io } = memoryIo();
    recordSelfUpdate({ execPath: BINARY_EXEC_PATH, fromVersion: '1.18.1', toVersion: '1.19.0', trigger: 'launch' }, io);
    recordSelfUpdate({ execPath: BINARY_EXEC_PATH, fromVersion: '1.19.0', toVersion: '1.20.0', trigger: 'periodic' }, io);

    const last = readLastSelfUpdate(BINARY_EXEC_PATH, io);
    expect(last?.fromVersion).toBe('1.19.0');
    expect(last?.trigger).toBe('periodic');
  });

  test('version output states the replacement instead of leaving a stray .previous as the only clue', () => {
    const rendered = renderGoodVibesVersion('goodvibes-agent', {
      execPath: BINARY_EXEC_PATH,
      readReceipt: () => ({
        at: '2026-07-27T12:00:00.000Z',
        fromVersion: '1.18.1',
        toVersion: '1.19.0',
        trigger: 'launch',
      }),
    });

    expect(rendered).toContain('replaced itself');
    expect(rendered).toContain('v1.18.1 -> v1.19.0');
    expect(rendered).toContain(`${BINARY_EXEC_PATH}.previous`);
    expect(rendered).toContain('update.autoUpdateAtLaunch');
  });

  test('a binary that never replaced itself says nothing extra', () => {
    const rendered = renderGoodVibesVersion('goodvibes-agent', {
      execPath: BINARY_EXEC_PATH,
      readReceipt: () => null,
    });
    expect(rendered.split('\n')).toHaveLength(1);
  });

  test('a corrupt receipt line is skipped rather than breaking version output', () => {
    const store = new Map<string, string>([[selfUpdateLogPath(BINARY_EXEC_PATH), 'not json\n{"at":"x"}\n']]);
    const io: SelfUpdateReceiptIo = {
      append: () => {},
      read: (path) => store.get(path) ?? null,
    };
    expect(readLastSelfUpdate(BINARY_EXEC_PATH, io)).toBeNull();
  });

  test('an unwritable install directory never turns a successful update into a failure', () => {
    const io: SelfUpdateReceiptIo = {
      append: () => {
        throw new Error('EROFS: read-only file system');
      },
      read: () => null,
    };
    expect(() =>
      recordSelfUpdate({ execPath: BINARY_EXEC_PATH, fromVersion: '1.18.1', toVersion: '1.19.0', trigger: 'launch' }, io),
    ).not.toThrow();
  });

  test('the receipt sentence names what happened in plain language', () => {
    const text = describeSelfUpdate(
      { at: '2026-07-27T12:00:00.000Z', fromVersion: '1.18.1', toVersion: '1.19.0', trigger: 'periodic' },
      BINARY_EXEC_PATH,
    );
    expect(text).toContain('while running');
    expect(text).toContain('2026-07-27T12:00:00.000Z');
  });
});
