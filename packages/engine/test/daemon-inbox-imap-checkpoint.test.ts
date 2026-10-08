import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as syncFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import type { ImapUidCheckpoint, ImapUidCheckpointAdvance, InboundChannelItem } from '../sdk/src/platform/intake/provider-adapter.ts';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const current = () => {};
const baseline = (uidValidity = 7): ImapUidCheckpoint => ({ kind: 'imap-uid', uidValidity,
  lastTerminalUid: null, history: { kind: 'bounded-seed', lowerBoundUid: 101, skippedOlderMessages: 80 } });
const seed = (next = baseline(), previous: ImapUidCheckpoint | null = null): ImapUidCheckpointAdvance => ({
  kind: 'imap-uid', transition: previous ? 'reset' : 'seed', previous, next, coveredUids: [], terminal: [],
});
const item = (id = 'email:7:101', provider = 'email'): InboundChannelItem => ({ id, provider, kind: 'dm',
  fromDigest: '0123456789abcdef', subjectPreview: 'Redacted subject', bodyPreview: 'Redacted body', receivedAt: Date.now(), unread: true });
function advance(previous = baseline(), rows = [item()]): ImapUidCheckpointAdvance {
  return { kind: 'imap-uid', transition: 'advance', previous, next: { ...previous, lastTerminalUid: 103 },
    coveredUids: [101, 103], terminal: [{ uid: 101, disposition: 'published', itemId: rows[0]!.id }, { uid: 103, disposition: 'suppressed' }] };
}
async function open(dir = makeProjectTempDir('inbox-imap-checkpoint')) {
  const store = new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 });
  cleanup.push(() => store.close());
  await store.init();
  return { store, dir };
}

// UID checkpoints and their durable rows are a distinct transactional path;
// the existing timestamp cursor suite pins legacy Slack/Discord semantics.
describe('durable IMAP inbox checkpoints', () => {
  test('seed records omitted history without claiming any terminal UID; restart preserves it', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    const { store: recovered } = await open(dir); // no close/flush on the writer
    expect(recovered.getImapCheckpoint('email')).toEqual(baseline());
    expect(recovered.getCursor('email')).toBe(0);
    expect(recovered.countItems()).toBe(0);
  });

  test('rows and terminal suppressed UIDs commit together; replay is CAS-fenced', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    expect(await store.commitImapPoll('email', [item()], advance(), current)).toBe(1);
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')?.lastTerminalUid).toBe(103);
    expect(recovered.countItems()).toBe(1);
    await expect(recovered.commitImapPoll('email', [item()], advance(), current)).rejects.toThrow('changed before commit');
    expect(recovered.countItems()).toBe(1);
  });

  test('empty full-history seed and max UID are distinct from timestamp progress', async () => {
    const { store } = await open();
    const initial: ImapUidCheckpoint = { kind: 'imap-uid', uidValidity: 0xffffffff, lastTerminalUid: null,
      history: { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 } };
    await store.commitImapPoll('email', [], seed(initial), current);
    const proposal: ImapUidCheckpointAdvance = { kind: 'imap-uid', transition: 'advance', previous: initial,
      next: { ...initial, lastTerminalUid: 0xffffffff }, coveredUids: [0xffffffff], terminal: [{ uid: 0xffffffff, disposition: 'gone' }] };
    await store.commitImapPoll('email', [], proposal, current);
    expect(store.getImapCheckpoint('email')?.lastTerminalUid).toBe(0xffffffff);
    expect(store.getCursor('email')).toBe(0);
  });

  test('UIDVALIDITY reset may lower UIDs and removes only that provider generation', async () => {
    const { store, dir } = await open();
    store.upsertItems([item('slack:one', 'slack')]); store.advanceCursor('slack', 800);
    await store.commitImapPoll('email', [], seed(), current);
    await store.commitImapPoll('email', [item()], advance(), current);
    const previous = store.getImapCheckpoint('email')!;
    const reset: ImapUidCheckpoint = { kind: 'imap-uid', uidValidity: 2, lastTerminalUid: null,
      history: { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 } };
    await store.commitImapPoll('email', [], seed(reset, previous), current);
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')).toEqual(reset);
    expect(recovered.listItems({ limit: 10 }).map(row => row.id)).toEqual(['slack:one']);
    expect(recovered.getCursor('slack')).toBe(800);
  });

  test('final currentness revocation discards staged rows and checkpoint in memory and on disk', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    let fences = 0;
    await expect(store.commitImapPoll('email', [item()], advance(), () => {
      fences += 1;
      expect(store.getImapCheckpoint('email')).toEqual(baseline());
      expect(store.countItems()).toBe(0);
      if (fences === 2) throw new Error('source revoked during write');
    })).rejects.toThrow('source revoked');
    expect(fences).toBe(2);
    expect(store.getImapCheckpoint('email')).toEqual(baseline());
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')).toEqual(baseline());
    expect(recovered.countItems()).toBe(0);
  });

  test('actual write failure leaves the checkpoint pending and permits a fresh retry', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    const write = spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('synthetic disk failure'));
    cleanup.push(() => write.mockRestore());
    await expect(store.commitImapPoll('email', [item()], advance(), current)).rejects.toThrow('disk failure');
    expect(store.getImapCheckpoint('email')).toEqual(baseline());
    expect(store.countItems()).toBe(0);
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')).toEqual(baseline());
    expect(await store.commitImapPoll('email', [item()], advance(), current)).toBe(1);
  });

  test('rename failure cannot publish a reset or retire the old durable generation', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    await store.commitImapPoll('email', [item()], advance(), current);
    const previous = store.getImapCheckpoint('email')!;
    const rename = spyOn(syncFs, 'renameSync').mockImplementationOnce(() => { throw new Error('synthetic rename failure'); });
    cleanup.push(() => rename.mockRestore());
    await expect(store.commitImapPoll('email', [], seed(baseline(8), previous), current)).rejects.toThrow('rename failure');
    expect(store.getImapCheckpoint('email')).toEqual(previous);
    expect(store.countItems()).toBe(1);
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')).toEqual(previous);
    expect(recovered.countItems()).toBe(1);
  });

  test('close reentered by the final fence drains staging without publishing a late checkpoint', async () => {
    const { store, dir } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    let fences = 0; let closing: Promise<void> | undefined;
    await expect(store.commitImapPoll('email', [item()], advance(), () => {
      if (++fences === 2) closing = store.close();
    })).rejects.toThrow('closed');
    await closing;
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')).toEqual(baseline());
    expect(recovered.countItems()).toBe(0);
  });

  test('concurrent other-provider mutation, retention and queued save survive stage rebasing', async () => {
    const { store, dir } = await open();
    store.upsertItems([{ ...item('expired', 'discord'), receivedAt: 1 }]);
    await store.commitImapPoll('email', [], seed(), current);
    let fences = 0; let queued: Promise<void> | undefined;
    await store.commitImapPoll('email', [item()], advance(), () => {
      if (++fences === 2) {
        store.upsertItems([item('slack:new', 'slack')]);
        store.advanceCursor('slack', 900);
        store.pruneOlderThan(2);
        queued = store.flush();
      }
    });
    await queued;
    expect(fences).toBe(4);
    const { store: recovered } = await open(dir);
    expect(recovered.getImapCheckpoint('email')?.lastTerminalUid).toBe(103);
    expect(recovered.listItems({ limit: 10 }).map(row => row.id).sort()).toEqual(['email:7:101', 'slack:new']);
    expect(recovered.getCursor('slack')).toBe(900);
  });

  test('an async currentness fence cannot authorize a commit', async () => {
    const { store } = await open();
    await expect(store.commitImapPoll('email', [], seed(), (async () => {}) as () => void)).rejects.toThrow('synchronous');
    expect(store.getImapCheckpoint('email')).toBeNull();
  });

  test('failed SQL transaction never publishes partial rows or progress', async () => {
    const dir = makeProjectTempDir('inbox-imap-sql-rollback');
    const backing = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'fixture.sqlite', schema: ['CREATE TABLE data (id TEXT PRIMARY KEY)'] });
    cleanup.push(() => backing.close());
    await backing.init();
    backing.run("INSERT INTO data VALUES ('before')");
    await backing.save();
    await expect(backing.persistTransaction(tx => {
      tx.run("INSERT INTO data VALUES ('after')");
      tx.run("INSERT INTO missing_table VALUES ('failure')");
    }, current)).rejects.toThrow();
    expect(backing.all('SELECT * FROM data')).toEqual([{ id: 'before' }]);
    const reopened = new HandlerSqliteStore({ workingDirectory: dir, fileName: 'fixture.sqlite', schema: [] });
    cleanup.push(() => reopened.close());
    await reopened.init();
    expect(reopened.all('SELECT * FROM data')).toEqual([{ id: 'before' }]);
  });

  test('invalid coverage, generation, seed and projection shapes are rejected without a write', async () => {
    const { store } = await open();
    await store.commitImapPoll('email', [], seed(), current);
    const valid = advance();
    const invalid: ImapUidCheckpointAdvance[] = [
      { ...valid, coveredUids: [101, 102, 103] },
      { ...valid, terminal: [valid.terminal[0]!] },
      { ...valid, next: { ...valid.next, uidValidity: 8 } },
      { ...valid, next: { ...valid.next, lastTerminalUid: 104 } },
      { ...valid, next: { ...valid.next, history: { ...valid.next.history, lowerBoundUid: 102 } } },
      { ...valid, transition: 'seed' },
      { ...seed(), next: { ...baseline(), lastTerminalUid: 100 } },
      { ...seed(), next: { ...baseline(), uidValidity: Number.MAX_SAFE_INTEGER } },
    ];
    for (const proposal of invalid) expect(() => store.commitImapPoll('email', [item()], proposal, current)).toThrow();
    expect(() => store.commitImapPoll('email', [{ ...item(), fromDigest: 'raw-sender@example.test' }], valid, current)).toThrow();
    expect(store.getImapCheckpoint('email')).toEqual(baseline());
    expect(store.countItems()).toBe(0);
  });

  test('unmodeled raw fields never enter the database and copies cannot be changed during persistence', async () => {
    const { store } = await open();
    const initial = baseline();
    const pendingSeed = store.commitImapPoll('email', [], seed(initial), current);
    // These are caller-owned objects; the admitted proposal has already copied them.
    (initial.history as { lowerBoundUid: number }).lowerBoundUid = 999;
    await pendingSeed;
    expect(store.getImapCheckpoint('email')?.history.lowerBoundUid).toBe(101);
    const raw = { ...item(), rawBody: 'SYNTHETIC_SECRET_SHOULD_NOT_PERSIST' };
    await store.commitImapPoll('email', [raw], advance(), current);
    expect(readFileSync(store.dbPath).includes(Buffer.from(raw.rawBody))).toBe(false);
  });

  test('accessor checkpoint fields are rejected without invoking them', async () => {
    const { store } = await open();
    let accessed = false;
    const input = { ...baseline(), get uidValidity() { accessed = true; return 7; } };
    expect(() => store.commitImapPoll('email', [], seed(input), current)).toThrow();
    expect(accessed).toBe(false);
    expect(store.getImapCheckpoint('email')).toBeNull();
  });

  for (const mode of ['before-rename', 'after-rename']) {
    test(`process crash ${mode} resumes from the matching durable rows and checkpoint`, async () => {
      const { store, dir } = await open();
      await store.commitImapPoll('email', [], seed(), current);
      await store.close();
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./_helpers/inbox-checkpoint-crash-child.ts', import.meta.url)), dir, mode],
        { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(mode === 'before-rename' ? 23 : 24);
      const { store: recovered } = await open(dir);
      expect(recovered.getImapCheckpoint('email')?.lastTerminalUid).toBe(mode === 'before-rename' ? null : 101);
      expect(recovered.countItems()).toBe(mode === 'before-rename' ? 0 : 1);
      if (mode === 'before-rename') {
        expect(await recovered.commitImapPoll('email', [item()], advance(), current)).toBe(1);
        expect(recovered.countItems()).toBe(1);
      }
    });
  }

  test('different account-owned files cannot reuse each other checkpoints', async () => {
    const { store: first } = await open(); const { store: second } = await open();
    await first.commitImapPoll('email', [], seed(), current);
    expect(second.getImapCheckpoint('email')).toBeNull();
    await second.commitImapPoll('email', [], seed(baseline(11)), current);
    expect(first.getImapCheckpoint('email')?.uidValidity).toBe(7);
    expect(second.getImapCheckpoint('email')?.uidValidity).toBe(11);
  });
});
