/**
 * One-touch daemon repair, at the seams a wedged machine actually has.
 *
 * The state under test is the incident state: the daemon service is stopped AND
 * `daemon.enabled` is false. Neither half alone is a fault, a stopped service
 * is started by the boot-time autostart, and a deliberate false is honored,
 * but together the flag short-circuits discovery before the autostart is ever
 * consulted, so the machine has no path back to a daemon.
 *
 * Four layers, matching the module's seams:
 *   1. The diagnosis, against a real scripted `goodvibes-daemon` executable
 *      resolved through PATH, the live daemon is never touched.
 *   2. The repair, driving that same real executable, proving what it was
 *      asked to do and what the receipt records.
 *   3. The interactive prompt controller: accept runs the repair, decline
 *      changes nothing and is remembered for the session.
 *   4. The shell's keypress path (handleBlockingShellInput), proving the offer
 *      consumes exactly one keystroke and then gets out of the way.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createDaemonCliRunner,
  readDaemonServiceReport,
} from '../../runtime/daemon-cli-service.ts';
import {
  createDaemonRepairSessionMemory,
  describeDaemonRepairForHeadless,
  diagnoseDaemonRepair,
  runDaemonRepair,
  type DaemonRepairConfig,
  type DaemonRepairOffer,
} from '../../runtime/daemon-repair.ts';
import { createDaemonRepairPrompt } from '../../shell/daemon-repair-prompt.ts';
import { handleBlockingShellInput } from '../../shell/blocking-input.ts';
import type { ConversationManager } from '../../core/conversation';
import type { SystemMessageRouter } from '../../core/system-message-router.ts';
import { createFakeDaemonCli, withPath } from '../helpers/fake-daemon-cli.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A settings double that records what the repair wrote. */
function fakeConfig(daemonEnabled: boolean, options: { readonly throwOnSet?: string } = {}): DaemonRepairConfig & {
  readonly writes: boolean[];
  readonly value: () => boolean;
} {
  const writes: boolean[] = [];
  let value = daemonEnabled;
  return {
    get: (key) => {
      if (key === 'daemon.enabled') return value;
      if (key === 'controlPlane.host') return '127.0.0.1';
      return 3421;
    },
    set: (_key, next) => {
      if (options.throwOnSet) throw new Error(options.throwOnSet);
      writes.push(next);
      value = next;
    },
    writes,
    value: () => value,
  };
}

function fakeRouter(): { high(message: string): void; readonly messages: string[] } {
  const messages: string[] = [];
  return { high: (message: string) => { messages.push(message); }, messages };
}

const NO_SLEEP = async (): Promise<void> => {};

// ── Layer 1: the diagnosis, over a real executable on PATH ──────────────────

describe('diagnoseDaemonRepair', () => {
  test('the wedged state, flag false AND service installed but stopped, produces the offer', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    await withPath(cli.binDir, () => {
      const offer = diagnoseDaemonRepair({
        config: fakeConfig(false),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      });
      expect(offer).not.toBeNull();
      expect(offer!.serviceInstalled).toBe(true);
      expect(offer!.serviceName).toBe('goodvibes');
      // ONE line that names both halves, so the user is not left inferring why
      // a stopped service was not simply started for them.
      expect(offer!.diagnosis).toContain('installed but stopped');
      expect(offer!.diagnosis).toContain('daemon.enabled');
      expect(offer!.offer).toContain('Press "y"');
      expect(offer!.offer).toContain('leaves everything untouched');
    });
    // The diagnosis reads; it never acts.
    expect(cli.calls()).toEqual(['service-status --json']);
  });

  test('flag false AND no service installed: the offer says it will install one', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    cli.setServiceState('not-installed');
    await withPath(cli.binDir, () => {
      const offer = diagnoseDaemonRepair({
        config: fakeConfig(false),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      });
      expect(offer!.serviceInstalled).toBe(false);
      expect(offer!.diagnosis).toContain('no daemon service is installed');
      expect(offer!.offer).toContain('install and start');
    });
  });

  test('a healthy machine costs nothing: the flag is true, so the daemon CLI is never even run', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    await withPath(cli.binDir, () => {
      expect(diagnoseDaemonRepair({
        config: fakeConfig(true),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      })).toBeNull();
    });
    expect(cli.calls()).toEqual([]);
  });

  test('a running daemon is a working configuration and is left alone', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    cli.setServiceState('running');
    await withPath(cli.binDir, () => {
      expect(diagnoseDaemonRepair({
        config: fakeConfig(false),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      })).toBeNull();
    });
  });

  test('a service manager that refuses the query is not an offer: guessing on an unanswered question is worse', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    cli.setServiceState('refused');
    await withPath(cli.binDir, () => {
      expect(diagnoseDaemonRepair({
        config: fakeConfig(false),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      })).toBeNull();
    });
  });

  test('an absent daemon CLI is a normal answer, never a boot failure', () => {
    // Nothing named this exists anywhere on PATH.
    const runner = createDaemonCliRunner({ binary: join('goodvibes-daemon-absent-for-this-test') });
    const report = readDaemonServiceReport(runner);
    expect(report.cliAvailable).toBe(false);
    expect(report.state).toBe('unknown');
    expect(diagnoseDaemonRepair({
      config: fakeConfig(false),
      session: createDaemonRepairSessionMemory(),
      runDaemonCli: runner,
    })).toBeNull();
  });

  test('a decline is remembered for the session: the very next diagnosis is silent', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    const session = createDaemonRepairSessionMemory();
    await withPath(cli.binDir, () => {
      expect(diagnoseDaemonRepair({ config: fakeConfig(false), session, runDaemonCli: createDaemonCliRunner() })).not.toBeNull();
      session.decline();
      expect(diagnoseDaemonRepair({ config: fakeConfig(false), session, runDaemonCli: createDaemonCliRunner() })).toBeNull();
    });
    // Exactly one status read: the second diagnosis short-circuits on the
    // remembered decline before it consults anything.
    expect(cli.calls()).toEqual(['service-status --json']);
  });
});

// ── Layer 2: the repair itself, driving the same real executable ────────────

describe('runDaemonRepair', () => {
  async function repairWith(options: {
    readonly serviceInstalled: boolean;
    readonly setup?: (cli: ReturnType<typeof createFakeDaemonCli>) => void;
    readonly reachable: boolean;
  }) {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    options.setup?.(cli);
    const config = fakeConfig(false);
    const receipts: string[] = [];
    const offer: DaemonRepairOffer = {
      serviceInstalled: options.serviceInstalled,
      serviceName: 'goodvibes',
      diagnosis: 'd',
      offer: 'o',
    };
    const result = await withPath(cli.binDir, () => runDaemonRepair({
      config,
      offer,
      runDaemonCli: createDaemonCliRunner(),
      verifyReachable: async () => options.reachable,
      waitTimeoutMs: 30,
      pollIntervalMs: 10,
      sleep: NO_SLEEP,
      recordReceipt: (text) => { receipts.push(text); },
    }));
    return { cli, config, result, receipts };
  }

  test('accepting repairs an installed-but-stopped service: flag set, service started, answer confirmed', async () => {
    const { cli, config, result, receipts } = await repairWith({ serviceInstalled: true, reachable: true });
    expect(result.repaired).toBe(true);
    expect(config.writes).toEqual([true]);
    expect(config.value()).toBe(true);
    // An installed unit is STARTED, never re-installed.
    expect(cli.calls()).toEqual(['start-service']);
    expect(result.steps[0]).toContain('set daemon.enabled to true');
    expect(result.steps[1]).toContain('started the daemon service');
    expect(result.steps[2]).toContain('confirmed the daemon answers');
    // The receipt names everything that was done, in one durable line.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('set daemon.enabled to true');
    expect(receipts[0]).toContain('started the daemon service');
    expect(receipts[0]).toContain('confirmed the daemon answers');
  });

  test('accepting with no unit installed installs one, which also starts it', async () => {
    const { cli, result } = await repairWith({
      serviceInstalled: false,
      setup: (fake) => fake.setServiceState('not-installed'),
      reachable: true,
    });
    expect(result.repaired).toBe(true);
    // install-service installs AND starts, so an absent unit takes one command.
    expect(cli.calls()).toEqual(['install-service']);
    expect(result.steps[1]).toContain('installed and started the daemon service');
  });

  test('a service that will not start is reported honestly, and never claimed as repaired', async () => {
    const { config, result, receipts } = await repairWith({
      serviceInstalled: true,
      setup: (fake) => fake.failStart('Failed to connect to bus: No medium found'),
      reachable: false,
    });
    expect(result.repaired).toBe(false);
    // The flag is still written: it is the half that silenced discovery, and
    // keeping it means the ordinary boot autostart can finish the job later.
    expect(config.value()).toBe(true);
    expect(result.summary).toContain('Not repaired');
    expect(result.summary).toContain('Failed to connect to bus');
    expect(receipts[0]).toContain('could not start the daemon service');
  });

  test('a service that starts but never answers is "partly repaired", not repaired', async () => {
    const { result } = await repairWith({ serviceInstalled: true, reachable: false });
    expect(result.repaired).toBe(false);
    expect(result.summary).toContain('Partly repaired');
    expect(result.steps.at(-1)).toContain('did not answer');
  });

  test('a settings write that fails stops the repair before it touches any service', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    const result = await withPath(cli.binDir, () => runDaemonRepair({
      config: fakeConfig(false, { throwOnSet: 'settings.json is read-only' }),
      offer: { serviceInstalled: true, serviceName: 'goodvibes', diagnosis: 'd', offer: 'o' },
      runDaemonCli: createDaemonCliRunner(),
      verifyReachable: async () => true,
      sleep: NO_SLEEP,
      recordReceipt: () => {},
    }));
    expect(result.repaired).toBe(false);
    expect(result.summary).toContain('Nothing was changed');
    expect(cli.calls()).toEqual([]);
  });
});

// ── Layer 3: the interactive prompt controller ──────────────────────────────

describe('createDaemonRepairPrompt', () => {
  const offer: DaemonRepairOffer = {
    serviceInstalled: true,
    serviceName: 'goodvibes',
    diagnosis: 'diagnosed',
    offer: 'offered',
  };

  test('"y" runs the repair and reports every step it took', async () => {
    const router = fakeRouter();
    const session = createDaemonRepairSessionMemory();
    let repaired = false;
    const prompt = createDaemonRepairPrompt({
      offer,
      config: fakeConfig(false),
      session,
      systemMessageRouter: router,
      render: () => {},
      repair: async () => {
        repaired = true;
        return { repaired: true, steps: ['step one', 'step two'], summary: '[Daemon] Repaired: all good.' };
      },
    });
    expect(prompt.pending()).toBe(true);
    expect(prompt.answer('y')).toBe(true);
    expect(prompt.pending()).toBe(false);
    // The repair is fire-and-forget from the keypress; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(repaired).toBe(true);
    expect(session.declined()).toBe(false);
    expect(router.messages.some((message) => message.includes('Starting the daemon service'))).toBe(true);
    expect(router.messages.some((message) => message.includes('Repaired: all good.'))).toBe(true);
    expect(router.messages.some((message) => message.includes('step one'))).toBe(true);
  });

  test('any other key declines: nothing runs, nothing changes, and the session remembers', () => {
    for (const key of ['n', '\x1b', '\x03', 'q', '\r']) {
      const router = fakeRouter();
      const session = createDaemonRepairSessionMemory();
      const config = fakeConfig(false);
      let ran = false;
      const prompt = createDaemonRepairPrompt({
        offer,
        config,
        session,
        systemMessageRouter: router,
        render: () => {},
        repair: async () => { ran = true; return { repaired: true, steps: [], summary: '' }; },
      });
      expect(prompt.answer(key)).toBe(true);
      expect(ran).toBe(false);
      expect(config.writes).toEqual([]);
      expect(config.value()).toBe(false);
      expect(session.declined()).toBe(true);
      expect(router.messages[0]).toContain('nothing was changed');
    }
  });

  test('the offer is answered once: a later keystroke is not this prompt\'s to consume', () => {
    const prompt = createDaemonRepairPrompt({
      offer,
      config: fakeConfig(false),
      session: createDaemonRepairSessionMemory(),
      systemMessageRouter: fakeRouter(),
      render: () => {},
      repair: async () => ({ repaired: true, steps: [], summary: '' }),
    });
    expect(prompt.answer('n')).toBe(true);
    expect(prompt.answer('y')).toBe(false);
    expect(prompt.pending()).toBe(false);
  });
});

// ── Layer 4: the shell's keypress path ──────────────────────────────────────

describe('handleBlockingShellInput (daemon repair offer)', () => {
  function shellOptions(daemonRepairPrompt: ReturnType<typeof createDaemonRepairPrompt> | null) {
    const router = fakeRouter();
    return {
      options: {
        data: 'y',
        pendingPermission: null,
        recoveryPending: null,
        daemonRepairPrompt,
        abortTurn: () => {},
        conversation: {} as unknown as ConversationManager,
        systemMessageRouter: router as unknown as SystemMessageRouter,
        render: () => {},
        consumeRecovery: () => null,
        removeRecoveryPoint: () => {},
      },
      router,
    };
  }

  function promptFor(onAnswer: (key: string) => void) {
    return createDaemonRepairPrompt({
      offer: { serviceInstalled: true, serviceName: 'goodvibes', diagnosis: 'd', offer: 'o' },
      config: fakeConfig(false),
      session: createDaemonRepairSessionMemory(),
      systemMessageRouter: fakeRouter(),
      render: () => {},
      repair: async () => { onAnswer('y'); return { repaired: true, steps: [], summary: 's' }; },
    });
  }

  test('the pending offer consumes the keystroke and starts the repair', () => {
    let started = false;
    const prompt = promptFor(() => { started = true; });
    const { options } = shellOptions(prompt);
    const result = handleBlockingShellInput(options);
    // handled: true is what keeps the "y" out of the composer, the user
    // answered a question, they did not type a character into their prompt.
    expect(result.handled).toBe(true);
    expect(prompt.pending()).toBe(false);
    expect(started).toBe(true);
  });

  test('once answered, the offer gets out of the way and typing flows through again', () => {
    const prompt = promptFor(() => {});
    const { options } = shellOptions(prompt);
    handleBlockingShellInput(options);
    const second = handleBlockingShellInput({ ...options, data: 'hello' });
    expect(second.handled).toBe(false);
  });

  test('with no offer pending, nothing about this path is engaged', () => {
    const { options } = shellOptions(null);
    expect(handleBlockingShellInput({ ...options, data: 'hello' }).handled).toBe(false);
  });
});

// ── Headless run mode ───────────────────────────────────────────────────────

describe('describeDaemonRepairForHeadless', () => {
  test('states the diagnosis and the offer without ever asking a question', async () => {
    const cli = createFakeDaemonCli(makeProjectTempDir('daemon-repair'));
    const lines = await withPath(cli.binDir, () => {
      const offer = diagnoseDaemonRepair({
        config: fakeConfig(false),
        session: createDaemonRepairSessionMemory(),
        runDaemonCli: createDaemonCliRunner(),
      });
      return describeDaemonRepairForHeadless(offer!);
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cannot reach a GoodVibes daemon');
    expect(lines[0]).toContain('daemon.enabled');
    // Run mode has nobody at the keyboard, so it must not tell the reader to
    // press a key here, it names where the offer can actually be taken.
    expect(lines[1]).not.toContain('Press "y" and the Agent will');
    expect(lines[1]).toContain('Start goodvibes-agent interactively');
    // And it changes nothing: only the read happened.
    expect(cli.calls()).toEqual(['service-status --json']);
  });
});
