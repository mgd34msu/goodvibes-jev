import { describe, expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import type { ImapUidCheckpoint } from '../sdk/src/platform/intake/provider-adapter.js';
import type { EmailInboxPageRead } from '../sdk/src/platform/email/email-inbox-page.js';
import { PageSocket } from './_helpers/mail-inbox-page.js';
import { snapshotFixture, SnapshotSocket } from './_helpers/mail-inbox-snapshot.js';
import { deferred, tick } from './_helpers/mail-subject-source.js';

const checkpoint = (lastTerminalUid: number | null = null): ImapUidCheckpoint => ({ kind: 'imap-uid',
  uidValidity: 7, lastTerminalUid, history: { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 } });
function seeded(result: EmailInboxPageRead) {
  expect(result.outcome).toBe('checkpoint-required');
  if (result.outcome !== 'checkpoint-required') throw new Error('Expected seed plan.');
  return result;
}
function complete(result: EmailInboxPageRead) {
  expect(result.outcome).toBe('complete');
  if (result.outcome !== 'complete') throw new Error('Expected complete page.');
  return result;
}
const fetched = (socket: SnapshotSocket): number[] => socket.commands.filter(command => command.includes('BODY.PEEK[HEADER]'))
  .map(command => Number(/UID FETCH (\d+)/.exec(command)?.[1]));

describe('UID baseline planning happens before any message read', () => {
  test('bounded seed pins actual newest-page boundary and skipped count without FETCH', async () => {
    const socket = new SnapshotSocket({ uids: [2, 8, 20, 70, 80] });
    const f = snapshotFixture({ sockets: [socket] });
    const plan = seeded(await f.service.readInboxPage({ limit: 2 }));
    expect(plan).toEqual({ outcome: 'checkpoint-required', transition: 'seed', previous: null,
      next: { kind: 'imap-uid', uidValidity: 7, lastTerminalUid: null,
        history: { kind: 'bounded-seed', lowerBoundUid: 70, skippedOlderMessages: 3 } },
      total: 5, pending: 2, selectedUids: [70, 80], coveredUids: [], hasMore: false });
    expect(socket.commands.some(command => /FETCH|UNSEEN|SINCE/.test(command))).toBe(false);
    expect(f.connections()).toBe(1); expect(socket.closed).toBe(true); expect(f.ingests).toHaveLength(0);
    for (const value of [plan, plan.next, plan.next.history, plan.selectedUids, plan.coveredUids]) expect(Object.isFrozen(value)).toBe(true);
    const observation = f.service.getInboxMailboxObservation(plan)!;
    expect(observation.uidValidity).toBe(7); expect(Object.isFrozen(observation)).toBe(true);
    expect(f.service.getInboxMailboxObservation({ ...plan })).toBeUndefined();
    expect(f.service.getInboxMailboxObservation(JSON.parse(JSON.stringify(plan)))).toBeUndefined();
    f.owner!.invalidate(); expect(observation.signal.aborted).toBe(true);
    expect(f.service.getInboxMailboxObservation(plan)).toBeUndefined();
  });

  test.each([{ uids: [] }, { uids: [42] }, { uids: [42, 43] }])('complete-history seed for current UIDs %j preserves lower bound one', async ({ uids }) => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ uids: [...uids] })] });
    const plan = seeded(await f.service.readInboxPage({ limit: 2 }));
    expect(plan.next.history).toEqual({ kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 });
    expect(plan.next.lastTerminalUid).toBeNull(); expect(plan.pending).toBe(uids.length);
    expect(plan.selectedUids).toEqual(uids); expect(plan.coveredUids).toEqual([]);
  });

  test('UIDVALIDITY replacement requests explicit reset without interpreting the old watermark', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket(), new SnapshotSocket({ validity: 9, uids: [1, 2, 3] })] });
    const old = seeded(await f.service.readInboxPage());
    const observation = f.service.getInboxMailboxObservation(old)!;
    const previous = checkpoint(999);
    const plan = seeded(await f.service.readInboxPage({ checkpoint: previous, limit: 2 }));
    expect(plan.transition).toBe('reset'); expect(plan.previous).toEqual(previous); expect(plan.previous).not.toBe(previous);
    expect(plan.next.uidValidity).toBe(9); expect(plan.next.lastTerminalUid).toBeNull();
    expect(plan.next.history).toEqual({ kind: 'bounded-seed', lowerBoundUid: 2, skippedOlderMessages: 1 });
    expect(fetched(f.sockets[1]!)).toEqual([]); expect(observation.signal.aborted).toBe(true);
    expect(f.service.getInboxMailboxObservation(plan)?.uidValidity).toBe(9);
  });

  test.each([null, 0, -1, 4294967296])('invalid UIDVALIDITY %s cannot seed or fetch', async validity => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ validity })] });
    const result = await f.service.readInboxPage();
    expect(result.outcome).toBe('incomplete'); expect(f.service.getInboxMailboxObservation(result)).toBeUndefined();
    expect(f.sockets[0]!.commands.some(command => /SEARCH|FETCH/.test(command))).toBe(false);
  });
});

describe('oldest pending pages preserve durable UID progress', () => {
  test('burst larger than limit drains oldest-first, independent of forged message dates', async () => {
    const uids = [10, 20, 30, 40, 50];
    const f = snapshotFixture({ sockets: Array.from({ length: 4 }, () => new PageSocket({ uids }, { unseenUids: [20, 50] })) });
    let saved = checkpoint();
    for (const [expected, pending, hasMore] of [[[10, 20], 5, true], [[30, 40], 3, true], [[50], 1, false]] as const) {
      const result = complete(await f.service.readInboxPage({ checkpoint: saved, limit: 2 }));
      expect(result.selectedUids).toEqual(expected); expect(result.coveredUids).toEqual(expected);
      expect(result.messages.map(message => message.source.detail.uid)).toEqual([...expected]);
      expect(result.pending).toBe(pending); expect(result.total).toBe(5); expect(result.hasMore).toBe(hasMore);
      expect(result.messages.map(message => message.unread)).toEqual(expected.map(uid => uid === 20 || uid === 50));
      saved = { ...saved, lastTerminalUid: expected.at(-1)! };
    }
    const empty = complete(await f.service.readInboxPage({ checkpoint: saved, limit: 2 }));
    expect(empty.messages).toEqual([]); expect(empty.coveredUids).toEqual([]); expect(empty.pending).toBe(0);
    expect(empty.total).toBe(5); expect(empty.hasMore).toBe(false); expect(fetched(f.sockets[3]!)).toEqual([]);
    expect(f.sockets.every(socket => socket.closed && socket.commands.every(command => !command.includes('SINCE')))).toBe(true);
  });

  test('failed first content cannot be lost to a later newest-page seed', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ uids: [1, 2, 70, 80] }),
      new PageSocket({ uids: [1, 2, 70, 80] }, { incompleteUid: 70 }),
      new PageSocket({ uids: [1, 2, 70, 80, 90, 100] })] });
    const saved = seeded(await f.service.readInboxPage({ limit: 2 })).next;
    const failed = await f.service.readInboxPage({ checkpoint: saved, limit: 2 });
    expect(failed.outcome).toBe('incomplete'); expect(f.service.getInboxMailboxObservation(failed)).toBeUndefined();
    const retried = complete(await f.service.readInboxPage({ checkpoint: saved, limit: 2 }));
    expect(retried.checkpoint).toEqual(saved); expect(retried.coveredUids).toEqual([70, 80]);
    expect(retried.pending).toBe(4); expect(retried.hasMore).toBe(true);
    expect(retried.checkpoint.history.skippedOlderMessages).toBe(2); expect(f.ingests).toHaveLength(2);
  });

  test.each(['gone', 'incomplete'] as const)('%s selected message withholds the whole page and coverage', async mode => {
    const socket = new PageSocket({}, mode === 'gone' ? { goneUid: 43 } : { incompleteUid: 43 });
    const f = snapshotFixture({ sockets: [socket] });
    const result = await f.service.readInboxPage({ checkpoint: checkpoint() });
    expect(result.outcome).toBe('incomplete'); expect('coveredUids' in result).toBe(false); expect('messages' in result).toBe(false);
    expect(f.service.getInboxMailboxObservation(result)).toBeUndefined(); expect(f.ingests).toHaveLength(0);
    expect(fetched(socket)).toEqual([42, 43]); expect(socket.closed).toBe(true);
  });

  test('complete page retains every exact raw source and text section with immutable result ownership', async () => {
    const socket = new PageSocket({ uids: [42] }, { multipart: true });
    const f = snapshotFixture({ sockets: [socket] });
    const result = complete(await f.service.readInboxPage({ checkpoint: checkpoint() }));
    const source = result.messages[0]!.source;
    expect(source.rawHeaders).toBe(socket.headers(42)); expect(source.rawBodyStructure).toContain('ALTERNATIVE');
    expect(source.textSections.map(section => section.text)).toEqual(['First', '<b>HTML</b>', 'Second']);
    for (const value of [result, result.checkpoint, result.checkpoint.history, result.messages, result.messages[0], source,
      source.detail, source.textSections, ...source.textSections, result.coveredUids, result.selectedUids]) expect(Object.isFrozen(value)).toBe(true);
    expect(f.service.getInboxMailboxObservation(result)?.uidValidity).toBe(7);
    expect(f.service.getInboxMailboxObservation({ ...result })).toBeUndefined();
    expect(f.service.getReplySubjectSource(source.detail)).toBeUndefined();
    expect(JSON.stringify(f.ingests)).toContain('Second'); expect(f.connections()).toBe(1);
  });

  test('aggregate source cap withholds all content rather than truncating a claimed complete page', async () => {
    const socket = new PageSocket({ uids: [1, 2, 3, 4, 5] }, { body: 'a'.repeat(900_000) });
    const f = snapshotFixture({ sockets: [socket] });
    const result = await f.service.readInboxPage({ checkpoint: checkpoint() });
    expect(result).toEqual({ outcome: 'incomplete', reason: 'Mail page exceeds the complete-source limit.' });
    expect(f.ingests).toHaveLength(0); expect(f.service.getInboxMailboxObservation(result)).toBeUndefined();
  });

  test.each(['ALL', 'UNSEEN'] as const)('malformed %s SEARCH cannot become empty or progress', async malformedSearch => {
    const socket = new PageSocket({}, { malformedSearch }); const f = snapshotFixture({ sockets: [socket] });
    await expect(f.service.readInboxPage({ checkpoint: checkpoint() })).rejects.toThrow('SEARCH');
    expect(fetched(socket)).toEqual([]); expect(socket.closed).toBe(true); expect(f.ingests).toHaveLength(0);
  });
});

describe('UID pages keep owned cancellation and argument snapshots', () => {
  test('missing source owner refuses before credentials or sockets', async () => {
    const f = snapshotFixture({ owner: null });
    await expect(f.service.readInboxPage()).rejects.toThrow('owned account lifetime');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
  });

  test.each([0, -1, 51, 1.5, NaN, Infinity])('invalid limit %s is refused before credentials or sockets', async limit => {
    const f = snapshotFixture(); await expect(f.service.readInboxPage({ limit })).rejects.toThrow('limit');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
  });

  test.each([{ uidValidity: 0 }, { lastTerminalUid: -1 }, { lastTerminalUid: Infinity },
    { history: { kind: 'complete', lowerBoundUid: 42, skippedOlderMessages: 0 } },
    { history: { kind: 'bounded-seed', lowerBoundUid: 42, skippedOlderMessages: 42 } },
    { history: { kind: 'bounded-seed', lowerBoundUid: 42, skippedOlderMessages: 1.5 } },
  ])('invalid checkpoint %j cannot reach credentials', async change => {
    const f = snapshotFixture();
    await expect(f.service.readInboxPage({ checkpoint: { ...checkpoint(), ...change } as ImapUidCheckpoint })).rejects.toThrow('checkpoint');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
  });

  test('nested checkpoint mutation during credential read cannot change selection or retained metadata', async () => {
    const gate = deferred<string | null>(); const f = snapshotFixture({ deps: { secretsManager: { get: () => gate.promise } } });
    const saved = { ...checkpoint(), history: { ...checkpoint().history } };
    const input = { checkpoint: saved, limit: 1 };
    const pending = f.service.readInboxPage(input);
    saved.lastTerminalUid = 43; saved.uidValidity = 99; saved.history.lowerBoundUid = 100;
    input.limit = 50; input.checkpoint = { ...checkpoint(43), history: { ...checkpoint().history } };
    gate.resolve('synthetic');
    const result = complete(await pending); expect(result.coveredUids).toEqual([42]); expect(result.checkpoint).toEqual(checkpoint());
  });

  test('non-enumerable pre-aborted signal is captured before all provider work', async () => {
    const f = snapshotFixture(); const stop = new AbortController(); stop.abort();
    await expect(f.service.readInboxPage(Object.defineProperty({}, 'signal', { value: stop.signal }))).rejects.toThrow('cancelled');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
  });

  test('held credentials drain on abort before any connection admission', async () => {
    const gate = deferred<string | null>(); const f = snapshotFixture({ deps: { secretsManager: { get: () => gate.promise } } });
    const stop = new AbortController(); let settled = false;
    const pending = f.service.readInboxPage({ signal: stop.signal }).finally(() => { settled = true; }); void pending.catch(() => {});
    stop.abort(); await tick(); expect(settled).toBe(false);
    gate.resolve('synthetic'); await expect(pending).rejects.toThrow('cancelled'); expect(f.connections()).toBe(0);
  });

  test('late cancelled connection drains close without authentication or seed receipt', async () => {
    const connection = deferred<Socket>(); const close = deferred<void>();
    const socket = new SnapshotSocket({ closeGate: close.promise });
    const f = snapshotFixture({ deps: { imapSocketFactory: () => connection.promise } });
    const stop = new AbortController(); let settled = false;
    const pending = f.service.readInboxPage({ signal: stop.signal }).finally(() => { settled = true; }); void pending.catch(() => {});
    await tick(); stop.abort(); connection.resolve(socket as unknown as Socket); await tick();
    expect(socket.destroyed).toBe(true); expect(settled).toBe(false); expect(socket.commands).toEqual([]);
    close.resolve(); await expect(pending).rejects.toThrow('cancelled'); expect(f.ingests).toHaveLength(0);
  });

  test.each(['greeting', ' LOGIN ', ' EXAMINE ', ' SEARCH ', 'BODY.PEEK[HEADER]', 'BODYSTRUCTURE', 'BODY.PEEK[1]', ' LOGOUT'])('abort during %s drains and withholds all result authority', async hold => {
    const socket = new SnapshotSocket({ hold }); const f = snapshotFixture({ sockets: [socket] });
    const stop = new AbortController(); const pending = f.service.readInboxPage({ checkpoint: checkpoint(), signal: stop.signal }); void pending.catch(() => {});
    await socket.reached.promise; stop.abort(); await expect(pending).rejects.toThrow();
    expect(socket.closed).toBe(true); expect(f.ingests).toHaveLength(0);
  });

  test.each([undefined, checkpoint()])('account invalidation during logout fences seed and content completion', async saved => {
    const socket = new SnapshotSocket({ hold: ' LOGOUT' }); const f = snapshotFixture({ sockets: [socket] });
    const pending = f.service.readInboxPage({ checkpoint: saved }); void pending.catch(() => {});
    await socket.reached.promise; f.owner!.invalidate(); await expect(pending).rejects.toThrow();
    expect(f.ingests).toHaveLength(0); expect(socket.closed).toBe(true);
  });

  test('reentrant ingest cancellation honors original signal despite caller replacing input', async () => {
    const gate = deferred<string | null>(); const original = new AbortController(); const replacement = new AbortController();
    let count = 0; const f = snapshotFixture({ deps: { secretsManager: { get: () => gate.promise },
      recordUntrustedIngest() { expect(f.sockets[0]!.closed).toBe(true); count++; original.abort(); } } });
    const input = { signal: original.signal, checkpoint: checkpoint() };
    const pending = f.service.readInboxPage(input); input.signal = replacement.signal; gate.resolve('synthetic');
    await expect(pending).rejects.toThrow('cancelled'); expect(count).toBe(1);
  });
});
