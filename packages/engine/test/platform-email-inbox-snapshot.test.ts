import { describe, expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { snapshotFixture, SnapshotSocket } from './_helpers/mail-inbox-snapshot.js';
import { deferred, tick } from './_helpers/mail-subject-source.js';

const requireValue = <T>(value: T | undefined): T => { expect(value).toBeDefined(); return value!; };

describe('owned inbox mailbox observations', () => {
  test('exact result evidence is immutable, separate from content and survives an unchanged mailbox read', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket(), new SnapshotSocket()] });
    const first = await f.service.listInbox();
    const observation = requireValue(f.service.getInboxMailboxObservation(first));
    expect(Object.isFrozen(observation)).toBe(true);
    expect(observation.mailbox).toBe('INBOX'); expect(observation.uidValidity).toBe(7);
    expect(Object.keys(first)).toEqual(['messages', 'total']);
    expect(f.service.getInboxMailboxObservation({ ...first })).toBeUndefined();
    expect(f.service.getInboxMailboxObservation(JSON.parse(JSON.stringify(first)))).toBeUndefined();
    Object.assign(first.messages[0]!, { mailbox: 'Forged', subject: 'Forged' });
    expect(observation.mailbox).toBe('INBOX');
    const second = await f.service.listInbox();
    expect(requireValue(f.service.getInboxMailboxObservation(second)).accountRevision).toBe(observation.accountRevision);
    expect(observation.signal.aborted).toBe(false);
    expect(() => observation.assertCurrent()).not.toThrow();
    f.owner!.invalidate();
    expect(observation.signal.aborted).toBe(true);
    expect(f.service.getInboxMailboxObservation(first)).toBeUndefined();
  });

  test.each([null, 0, -1, 4294967296])('invalid UIDVALIDITY %s does not create mailbox evidence', async validity => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ validity })] });
    const result = await f.service.listInbox();
    expect(result.messages).toHaveLength(2);
    expect(f.service.getInboxMailboxObservation(result)).toBeUndefined();
  });

  test('missing lifecycle owner preserves display but no observation; strict batch refuses before I/O', async () => {
    const f = snapshotFixture({ owner: null });
    expect(f.service.getInboxMailboxObservation(await f.service.listInbox())).toBeUndefined();
    await expect(f.service.readInboxBatch()).rejects.toThrow('owned account lifetime');
    expect(f.connections()).toBe(1);
  });

  test('mailbox replacement and account ABA revoke existing observations', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket(), new SnapshotSocket({ validity: 9 }), new SnapshotSocket()] });
    const first = requireValue(f.service.getInboxMailboxObservation(await f.service.listInbox()));
    const second = requireValue(f.service.getInboxMailboxObservation(await f.service.listInbox()));
    expect(first.signal.aborted).toBe(true); expect(second.uidValidity).toBe(9);
    f.owner!.invalidate(); f.owner!.invalidate();
    const third = requireValue(f.service.getInboxMailboxObservation(await f.service.listInbox()));
    expect(second.signal.aborted).toBe(true); expect(third.accountRevision).not.toBe(second.accountRevision);
    f.owner!.dispose(); expect(third.signal.aborted).toBe(true);
  });
});

describe('inbox read cancellation owns real work', () => {
  test.each(['list', 'batch'] as const)('pre-aborted %s read starts no work', async kind => {
    const f = snapshotFixture(); const stop = new AbortController(); stop.abort();
    await expect(kind === 'list' ? f.service.listInbox({ signal: stop.signal }) : f.service.readInboxBatch({ signal: stop.signal })).rejects.toThrow('cancelled');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0); expect(f.ingests).toHaveLength(0);
  });

  test('held secret read drains before rejection and opens no socket', async () => {
    const gate = deferred<string | null>(); const f = snapshotFixture({ deps: { secretsManager: { get: () => gate.promise } } });
    const stop = new AbortController(); let settled = false;
    const pending = f.service.listInbox({ signal: stop.signal }).finally(() => { settled = true; });
    void pending.catch(() => {}); stop.abort(); await tick(); expect(settled).toBe(false);
    gate.resolve('synthetic'); await expect(pending).rejects.toThrow('cancelled');
    expect(f.connections()).toBe(0); expect(f.ingests).toHaveLength(0);
  });

  test('late connector socket is destroyed and drained without authentication', async () => {
    const gate = deferred<Socket>(); const close = deferred<void>(); const socket = new SnapshotSocket({ closeGate: close.promise });
    const f = snapshotFixture({ deps: { imapSocketFactory: () => gate.promise } });
    const stop = new AbortController(); let settled = false;
    const pending = f.service.listInbox({ signal: stop.signal }).finally(() => { settled = true; }); void pending.catch(() => {});
    await tick(); stop.abort(); await tick(); expect(settled).toBe(false);
    gate.resolve(socket as unknown as Socket); await tick(); expect(socket.destroyed).toBe(true); expect(settled).toBe(false);
    close.resolve(); await expect(pending).rejects.toThrow('cancelled'); expect(socket.commands).toHaveLength(0);
  });

  test.each(['greeting', ' LOGIN ', ' EXAMINE ', ' SEARCH ', 'HEADER.FIELDS', 'BODY.PEEK[TEXT]', ' LOGOUT'])('abort during %s drains transport and never publishes', async hold => {
    const socket = new SnapshotSocket({ hold }); const f = snapshotFixture({ sockets: [socket] });
    const stop = new AbortController(); const pending = f.service.listInbox({ signal: stop.signal }); void pending.catch(() => {});
    await socket.reached.promise; stop.abort();
    await expect(pending).rejects.toThrow(); expect(socket.closed).toBe(true); expect(f.ingests).toHaveLength(0);
  });

  test('owner invalidation at held logout fences callbacks and receipt issuance', async () => {
    const socket = new SnapshotSocket({ hold: ' LOGOUT' }); const f = snapshotFixture({ sockets: [socket] });
    const pending = f.service.listInbox(); void pending.catch(() => {}); await socket.reached.promise;
    f.owner!.invalidate(); await expect(pending).rejects.toThrow(); expect(f.ingests).toHaveLength(0);
  });

  test('reentrant ingest invalidation cannot publish or emit later messages', async () => {
    let count = 0; const f = snapshotFixture({ deps: { recordUntrustedIngest() { count++; f.owner!.invalidate(); } } });
    await expect(f.service.listInbox()).rejects.toThrow(); expect(count).toBe(1);
  });
});

describe('strict batch snapshot ownership', () => {
  test('complete frozen newest-UID snapshot carries every body and exact mailbox observation', async () => {
    const f = snapshotFixture(); const result = await f.service.readInboxBatch({ limit: 2 });
    expect(result.outcome).toBe('complete');
    if (result.outcome !== 'complete') throw new Error(result.reason);
    expect(result.messages.map(message => message.source.detail.uid)).toEqual([43, 42]);
    expect(result.messages.every(message => message.source.textSections[0]?.text === 'Synthetic body')).toBe(true);
    expect(result.total).toBe(2); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.messages[0]!.source.detail)).toBe(true);
    expect(requireValue(f.service.getInboxMailboxObservation(result)).uidValidity).toBe(7);
    expect(f.service.getInboxMailboxObservation({ ...result })).toBeUndefined();
    expect(f.service.getReplySubjectSource(result.messages[0]!.source.detail)).toBeUndefined();
    expect(f.ingests).toHaveLength(2);
    expect(f.sockets[0]!.commands.some(command => command.includes('SINCE'))).toBe(false);
  });

  test('unreadable body withholds entire batch, evidence and ingest rather than synthesizing empty content', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ incompleteBody: true })] });
    const result = await f.service.readInboxBatch(); expect(result.outcome).toBe('incomplete');
    expect(f.service.getInboxMailboxObservation(result)).toBeUndefined(); expect(f.ingests).toHaveLength(0);
  });

  test('empty mailbox is a genuine complete empty snapshot with account evidence', async () => {
    const f = snapshotFixture({ sockets: [new SnapshotSocket({ uids: [] })] });
    const result = await f.service.readInboxBatch(); expect(result).toEqual({ outcome: 'complete', messages: [], total: 0 });
    expect(f.service.getInboxMailboxObservation(result)).toBeDefined(); expect(f.ingests).toHaveLength(0);
  });

  test.each([0, -1, 51, 1.5, NaN, Infinity])('invalid batch limit %s refuses before credentials or sockets', async limit => {
    const f = snapshotFixture(); await expect(f.service.readInboxBatch({ limit })).rejects.toThrow('limit');
    expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
  });

  test.each(['BODY.PEEK[HEADER]', 'BODYSTRUCTURE', 'BODY.PEEK[1]', ' LOGOUT'])('batch abort during %s never publishes', async hold => {
    const socket = new SnapshotSocket({ hold }); const f = snapshotFixture({ sockets: [socket] });
    const stop = new AbortController(); const pending = f.service.readInboxBatch({ signal: stop.signal }); void pending.catch(() => {});
    await socket.reached.promise; stop.abort(); await expect(pending).rejects.toThrow();
    expect(socket.closed).toBe(true); expect(f.ingests).toHaveLength(0);
  });

  test.each(['list', 'batch'] as const)('%s captures caller signal once before asynchronous admission', async kind => {
    const gate = deferred<string | null>(); const original = new AbortController(); const replacement = new AbortController();
    let count = 0;
    const f = snapshotFixture({ deps: { secretsManager: { get: () => gate.promise },
      recordUntrustedIngest() { count++; original.abort(); } } });
    const input = { signal: original.signal };
    const pending = kind === 'list' ? f.service.listInbox(input) : f.service.readInboxBatch(input);
    input.signal = replacement.signal; gate.resolve('synthetic');
    await expect(pending).rejects.toThrow('cancelled'); expect(count).toBe(1);
  });
});

test.each(['list', 'batch'] as const)('%s honors non-enumerable cancellation without touching providers', async kind => {
  const f = snapshotFixture(); const stop = new AbortController(); stop.abort();
  const input = Object.defineProperty({}, 'signal', { value: stop.signal });
  await expect(kind === 'list' ? f.service.listInbox(input) : f.service.readInboxBatch(input)).rejects.toThrow('cancelled');
  expect(f.connections()).toBe(0); expect(f.secrets()).toBe(0);
});
