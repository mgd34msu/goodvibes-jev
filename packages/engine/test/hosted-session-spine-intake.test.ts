/**
 * hosted-session-spine-intake.test.ts
 *
 * What happens to the owner's message when handing it to a hosted session's
 * loop FAILS.
 *
 * The intake marked every collected input consumed whether or not delivery
 * succeeded, so the record said the message had been answered when nothing had
 * received it, and the only trace was a warn line in the daemon log. On a
 * survive-detach session with nobody attached that is a message that vanished.
 *
 * So: a failure keeps the input, retries it, and, once the attempts are spent
 *, fails it on the spine and puts the incident in front of the owner. And the
 * tick itself never throws out of its own interval, which used to be an
 * unhandled rejection on a read that would have succeeded a moment later.
 *
 * tick() no longer waits for a delivery (a delivery is the whole turn, and
 * waiting for one froze every other session's heartbeat), so these tests ask
 * for the outcome with drainDeliveries(). The behaviour being asserted is
 * unchanged; only the moment it is observable moved.
 */
import { describe, expect, test, spyOn } from 'bun:test';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import { useFailureReadings, failureReadingsPort } from './_helpers/failure-readings.ts';
useFailureReadings([]);
import { HostedSessionSpineIntake, type HostedSessionSpine } from '../sdk/src/platform/hosted-sessions/spine-intake.ts';
import type { HostedSessionRecord } from '../sdk/src/platform/hosted-sessions/types.ts';

function record(id = 'hosted-1'): HostedSessionRecord {
  return {
    id,
    workspaceRoot: '/w',
    title: 'a session',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'survive',
    attachedClients: [],
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
    messageCount: 0,
    restoredFromDisk: false,
    contractIds: [],
  };
}

interface SpineLog {
  readonly delivered: string[];
  readonly consumed: string[];
  readonly failed: { inputId: string; error: string }[];
}

function buildSpine(queued: Map<string, { id: string; body: string; correlationId?: string }[]>): HostedSessionSpine & { log: SpineLog } {
  const log: SpineLog = { delivered: [], consumed: [], failed: [] };
  return {
    log,
    register: async () => ({}),
    closeSession: async () => ({}),
    getInputsSince: (sessionId) => queued.get(sessionId) ?? [],
    markInputDelivered: async (sessionId, inputId, options) => {
      if (options?.consumed === true) {
        log.consumed.push(inputId);
      } else {
        log.delivered.push(inputId);
        // Collecting takes it out of the queued set, exactly as the broker does.
        queued.set(sessionId, (queued.get(sessionId) ?? []).filter((entry) => entry.id !== inputId));
      }
      return {};
    },
    failInput: async (_sessionId, inputId, error) => {
      log.failed.push({ inputId, error });
      return {};
    },
  };
}

describe('a delivery that failed is not a delivery that happened', () => {
  test('captured input correlation survives a collection await and delivery retry', async () => {
    const input = { id: 'input-1', body: 'answer me', correlationId: 'caller:first' };
    const spine = buildSpine(new Map([['hosted-1', [input]]]));
    const mark = spine.markInputDelivered;
    spine.markInputDelivered = async (...args) => {
      const result = await mark(...args);
      input.correlationId = 'later mutation';
      return result;
    };
    const observed: (string | undefined)[] = [];
    const intake = new HostedSessionSpineIntake({
      spine, liveSessions: () => [record()], now: () => 1,
      deliver: async (_sessionId, _body, correlationId) => {
        observed.push(correlationId);
        if (observed.length === 1) throw new Error('composition is not ready');
      },
    });
    await intake.tick();
    await intake.drainDeliveries();
    await intake.tick();
    await intake.drainDeliveries();
    expect(observed).toEqual(['caller:first', 'caller:first']);
    expect(spine.log.consumed).toEqual(['input-1']);
  });

  test('each queued input retains its correlation within its own session lane', async () => {
    const spine = buildSpine(new Map([
      ['a', [{ id: 'same-id', body: 'same prompt', correlationId: 'a:first' },
        { id: 'next', body: 'same prompt', correlationId: 'a:next' }]],
      ['b', [{ id: 'same-id', body: 'same prompt', correlationId: 'b:first' },
        { id: 'legacy', body: 'uncorrelated' }]],
    ]));
    const observed = new Map<string, (string | undefined)[]>();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const intake = new HostedSessionSpineIntake({
      spine, liveSessions: () => [record('a'), record('b')], now: () => 1,
      deliver: async (sessionId, _body, correlationId) => {
        observed.set(sessionId, [...(observed.get(sessionId) ?? []), correlationId]);
        if (correlationId === 'a:first') await held;
      },
    });
    try {
      await intake.tick();
      await intake.tick();
      expect(observed.get('a')).toEqual(['a:first']);
      expect(observed.get('b')).toEqual(['b:first', undefined]);
      release();
      await intake.drainDeliveries();
      expect(observed.get('a')).toEqual(['a:first', 'a:next']);
      expect(spine.log.consumed).toHaveLength(4);
    } finally { release(); intake.stop(); await intake.drainDeliveries(); }
  });

  test('a transient failure is retried on the next tick and then completes', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    let attempts = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('its loop is still being composed');
      },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(1);
    // The one thing that must not happen: the record saying it was answered.
    expect(spine.log.consumed).toEqual([]);
    expect(spine.log.failed).toEqual([]);

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(2);
    expect(spine.log.consumed).toEqual(['input-1']);
    expect(spine.log.failed).toEqual([]);
  });

  test('a failure that will not clear is failed on the spine and told to the owner', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const alerts: string[] = [];
    let attempts = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 3,
      alertOwner: (text) => { alerts.push(text); },
      deliver: async () => {
        attempts += 1;
        throw new Error('this session is terminated');
      },
    });

    await intake.tick();
    await intake.drainDeliveries();
    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.failed).toEqual([]);
    expect(alerts).toEqual([]);

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(3);
    expect(spine.log.consumed).toEqual([]);
    expect(spine.log.failed).toHaveLength(1);
    expect(spine.log.failed[0]?.inputId).toBe('input-1');
    expect(spine.log.failed[0]?.error).toContain('this session is terminated');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('hosted-1');
    expect(alerts[0]).toContain('could not be delivered');

    // Spent, not retried forever.
    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(3);
  });

  test('a spine that cannot mark a failure leaves the input collected, never consumed', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    delete (spine as { failInput?: unknown }).failInput;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 1,
      deliver: async () => { throw new Error('nope'); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.delivered).toEqual(['input-1']);
    expect(spine.log.consumed).toEqual([]);
  });

  test('an owner alerter that throws does not take the tick with it', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 1,
      alertOwner: () => { throw new Error('every channel is down'); },
      deliver: async () => { throw new Error('nope'); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.failed).toHaveLength(1);
  });

  test('a successful delivery still completes the record, as it always did', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const submitted: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async (_sessionId, text) => { submitted.push(text); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual(['answer me']);
    expect(spine.log.delivered).toEqual(['input-1']);
    expect(spine.log.consumed).toEqual(['input-1']);
  });
});

describe('the tick never rejects into its own interval', () => {
  test('a throwing liveSessions() is absorbed and the next tick recovers', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    let broken = true;
    const submitted: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      now: () => 1,
      liveSessions: () => {
        if (broken) throw new Error('the store is mid-write');
        return [record()];
      },
      deliver: async (_sessionId, text) => { submitted.push(text); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual([]);

    broken = false;
    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual(['answer me']);
  });

  test('a throwing getInputsSince() is absorbed too', async () => {
    const intake = new HostedSessionSpineIntake({
      spine: {
        register: async () => ({}),
        closeSession: async () => ({}),
        getInputsSince: () => { throw new Error('the bucket is being compacted'); },
        markInputDelivered: async () => ({}),
      },
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async () => undefined,
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(true).toBe(true);
  });
});

for (const phase of ['registration', 'close'] as const) {
  for (const asynchronous of [false, true]) {
    test(`direct ${phase} ${asynchronous ? 'async' : 'sync'} callback cannot await its own spine close`, async () => {
      let recursiveError: unknown;
      let closed = 0;
      const reenter = async () => {
        if (asynchronous) await Promise.resolve();
        try { await intake.close('owned'); }
        catch (error) { recursiveError = error; }
      };
      const intake = new HostedSessionSpineIntake({
        spine: {
          register: async () => { if (phase === 'registration') await reenter(); },
          closeSession: async () => { closed += 1; if (phase === 'close') await reenter(); },
          getInputsSince: () => [], markInputDelivered: async () => undefined,
        },
        liveSessions: () => [], now: () => 1, deliver: async () => undefined,
      });
      await intake.register(record('owned'));
      if (phase === 'registration') expect(closed).toBe(0);
      await intake.close('owned');
      expect(String(recursiveError)).toContain('lifecycle callback cannot await its own spine drain');
      expect(closed).toBe(1);
    });
  }
}

test('a direct intake callback may close an unrelated session', async () => {
  const closed: string[] = [];
  const intake = new HostedSessionSpineIntake({
    spine: {
      register: async () => { await intake.close('other'); },
      closeSession: async id => { closed.push(id); },
      getInputsSince: () => [], markInputDelivered: async () => undefined,
    },
    liveSessions: () => [], now: () => 1, deliver: async () => undefined,
  });
  await intake.register(record('owned'));
  expect(closed).toEqual(['other']);
});

test('a detached continuation after direct registration settles can close its session', async () => {
  let invoke!: () => void;
  const gate = new Promise<void>(resolve => { invoke = resolve; });
  let detached: Promise<void> | undefined;
  let closed = false;
  const intake = new HostedSessionSpineIntake({
    spine: {
      register: async () => { detached = gate.then(() => intake.close('owned')); },
      closeSession: async () => { closed = true; },
      getInputsSince: () => [], markInputDelivered: async () => undefined,
    },
    liveSessions: () => [], now: () => 1, deliver: async () => undefined,
  });
  await intake.register(record('owned'));
  invoke();
  await detached;
  expect(closed).toBe(true);
});

describe('A-F1540 hosted delivery transience uses the actual failure', () => {
  function fixture(port = failureReadingsPort([['same wording', { category: 'authorization' }]]).port, error: unknown = new Error('same wording')) {
    const spine = buildSpine(new Map([['hosted-1', [{ id: 'input-1', body: 'original body', correlationId: 'original-correlation' }]]]));
    const deliveries: unknown[][] = [], alerts: string[] = [];
    const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
      failureReading: { port }, deliver: async (...args) => { deliveries.push(args); throw error; }, alertOwner: text => alerts.push(text),
    });
    return { spine, intake, deliveries, alerts };
  }
  test('terminal wording fails at the first delivery even with attempts remaining', async () => {
    const f = fixture(); await f.intake.tick(); await f.intake.drainDeliveries();
    expect(f.spine.log.failed).toEqual([{ inputId: 'input-1', error: 'same wording' }]);
    await f.intake.tick(); await f.intake.drainDeliveries(); expect(f.deliveries).toHaveLength(1);
    expect(f.spine.log.consumed).toEqual([]); expect(f.alerts).toHaveLength(1);
  });
  test('same wording under a different captured reader retries, with the bounded ceiling', async () => {
    const port = failureReadingsPort([['same wording', { category: 'network', transientNetwork: true }]]);
    const f = fixture(port.port);
    for (let index = 0; index < 4; index++) { await f.intake.tick(); await f.intake.drainDeliveries(); }
    expect(f.deliveries).toHaveLength(3); expect(f.spine.log.failed).toHaveLength(1);
    expect(f.deliveries.every(args => args[1] === 'original body' && args[2] === 'original-correlation')).toBe(true);
    expect(port.requests).toHaveLength(3);
  });
  test('structured terminal status beats ambiguous prose without a semantic call', async () => {
    const port = failureReadingsPort([]); const f = fixture(port.port, Object.assign(new Error('please try again'), { status: 403 }));
    await f.intake.tick(); await f.intake.drainDeliveries();
    expect(f.spine.log.failed).toHaveLength(1); expect(port.requests).toHaveLength(0);
  });
  for (const action of ['stop', 'fence'] as const) test(`${action} during reading cannot enqueue retry, fail or alert`, async () => {
    const base = failureReadingsPort([]).port;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ ...base, async ask(request) { enter(); await held; return base.ask(request); } });
    await f.intake.tick(); await entered;
    if (action === 'stop') f.intake.stop(); else f.intake.fence('hosted-1');
    release(); await f.intake.drainDeliveries(); await f.intake.tick(); await f.intake.drainDeliveries();
    expect(f.deliveries).toHaveLength(1); expect(f.spine.log.failed).toEqual([]); expect(f.alerts).toEqual([]);
  });
  test('a failed semantic read cannot resend the input before eligibility is known', async () => {
    const base = failureReadingsPort([['same wording', { category: 'authorization' }]]).port;
    let reads = 0;
    const f = fixture({ ...base, ask(request) { if (++reads === 1) throw new Error('synthetic reader unavailable'); return base.ask(request); } });
    await f.intake.tick(); await f.intake.drainDeliveries(); expect(f.deliveries).toHaveLength(1);
    expect(f.spine.log.failed).toEqual([]);
    await f.intake.tick(); await f.intake.drainDeliveries();
    expect(f.deliveries).toHaveLength(1); expect(f.spine.log.failed).toHaveLength(1); expect(reads).toBe(2);
  });
});

test('A-F1540 retained error cannot mutate between failed reading attempts', async () => {
  const base = failureReadingsPort([['original authorization failure', { category: 'authorization' }], ['new transient failure', { category: 'network' }]]);
  const failure = new Error('original authorization failure');
  let reads = 0, deliveries = 0;
  const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
  const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
    failureReading: { port: { ...base.port, ask(request) { if (++reads === 1) throw new Error('reader unavailable'); return base.port.ask(request); } } },
    deliver: async () => { deliveries++; throw failure; },
  });
  await intake.tick(); await intake.drainDeliveries(); failure.message = 'new transient failure';
  await intake.tick(); await intake.drainDeliveries();
  expect(deliveries).toBe(1); expect(spine.log.failed).toEqual([{ inputId: 'one', error: 'original authorization failure' }]);
  expect(JSON.stringify(base.requests)).not.toContain('new transient failure');
});
test('A-F1540 executable/protected failure evidence never reaches a reader or a redelivery', async () => {
  for (const failure of [Object.defineProperty(new Error('synthetic'), 'message', { get() { throw new Error('getter must not run'); } }),
    Object.assign(new Error('synthetic'), { code: 'Authorization: Bearer synthetic-private-provider-key' })]) {
    const reader = failureReadingsPort([]); let deliveries = 0;
    const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
    const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1, failureReading: { port: reader.port },
      deliver: async () => { deliveries++; throw failure; } });
    for (let index = 0; index < 2; index++) { await intake.tick(); await intake.drainDeliveries(); }
    expect(deliveries).toBe(1); expect(reader.requests).toHaveLength(0); expect(spine.log.failed).toEqual([]); expect(spine.log.consumed).toEqual([]);
  }
});

test('A-F1540 structured fast paths obey cancellation before effects', async () => {
  const port = failureReadingsPort([]); let deliveries = 0;
  const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
  const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
    failureReading: { port: port.port, beforeAttempt() { intake.stop(); } },
    deliver: async () => { deliveries++; throw Object.assign(new Error('synthetic denied'), { status: 403 }); } });
  await intake.tick(); await intake.drainDeliveries();
  expect(deliveries).toBe(1); expect(port.requests).toHaveLength(0); expect(spine.log.failed).toEqual([]);
});
test('A-F1540 reader exceptions never echo raw secret-bearing wording', async () => {
  const secret = 'Authorization: Bearer synthetic-private-reader-secret';
  const port = failureReadingsPort([]).port;
  const warns: unknown[][] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warns.push(args); });
  const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
  const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
    failureReading: { port: { ...port, ask() { throw new Error(secret); } } }, deliver: async () => { throw new Error('safe original failure'); } });
  try {
    await intake.tick(); await intake.drainDeliveries();
    expect(warns.length).toBeGreaterThan(0); expect(JSON.stringify(warns)).not.toContain(secret);
    expect(spine.log.failed).toEqual([]); expect(spine.log.consumed).toEqual([]);
  } finally { warn.mockRestore(); }
});

test('A-F1540 an async authority guard cannot be hidden by the caller wrapper', async () => {
  const port = failureReadingsPort([]); let deliveries = 0;
  const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
  const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
    failureReading: { port: port.port, beforeAttempt: async () => { throw new Error('synthetic async authority rejection'); } },
    deliver: async () => { deliveries++; throw Object.assign(new Error('synthetic denied'), { status: 403 }); } });
  await intake.tick(); await intake.drainDeliveries(); await Promise.resolve();
  expect(deliveries).toBe(1); expect(port.requests).toHaveLength(0); expect(spine.log.failed).toEqual([]);
});
for (const action of ['stop', 'fence'] as const) test(`A-F1540 rejected async guard that synchronously ${action}s is drained without effects`, async () => {
  const port = failureReadingsPort([]);
  const spine = buildSpine(new Map([['hosted-1', [{ id: 'one', body: 'body' }]]]));
  const intake = new HostedSessionSpineIntake({ spine, liveSessions: () => [record()], now: () => 1,
    failureReading: { port: port.port, beforeAttempt: async () => {
      if (action === 'stop') intake.stop(); else intake.fence('hosted-1');
      throw new Error('synthetic async authority rejection');
    } }, deliver: async () => { throw Object.assign(new Error('synthetic denied'), { status: 403 }); } });
  await intake.tick(); await intake.drainDeliveries(); await Promise.resolve();
  expect(port.requests).toHaveLength(0); expect(spine.log.failed).toEqual([]);
});
