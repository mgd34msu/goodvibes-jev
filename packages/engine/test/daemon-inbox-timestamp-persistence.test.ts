import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller } from '../sdk/src/platform/intake/poller.ts';
import type { InboundChannelItem, InboundProviderAdapter } from '../sdk/src/platform/intake/provider-adapter.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const row = (id = 'slack:new', receivedAt = 200): InboundChannelItem => ({ id, provider: 'slack', kind: 'dm',
  fromDigest: '0123456789abcdef', subjectPreview: 'Redacted', bodyPreview: 'Redacted', receivedAt, unread: true });
async function open(dir = makeProjectTempDir('inbox-timestamp-persistence')) {
  const store = new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0, now: () => 0 });
  cleanup.push(() => store.close()); await store.init(); return { store, dir };
}

describe('timestamp inbox atomic persistence', () => {
  for (const reason of ['account revoked', 'source revoked', 'credential rotated', 'generation stopped']) {
    test(`${reason} during the asynchronous write cannot publish rows or cursor`, async () => {
      const { store, dir } = await open();
      await store.commitTimestampPoll('slack', [row('slack:old', 100)], () => {});
      let revoked = false;
      const adapter: InboundProviderAdapter = { id: 'slack', pollIntervalMs: 1000,
        async poll() { return { state: 'ready', configured: true, items: [row()] }; },
        assertCurrent() { if (revoked) throw new Error(reason); } };
      const poller = new InboundPoller({ store, adapters: new Map([['slack', adapter]]), logger: { info() {}, warn() {}, error() {} } });
      cleanup.push(() => poller.stop());
      const writing = deferred(); const release = deferred();
      const original = fs.writeFile;
      const write = spyOn(fs, 'writeFile').mockImplementationOnce(async (...args: Parameters<typeof fs.writeFile>) => {
        await original(...args); writing.resolve(); await release.promise;
      });
      cleanup.push(() => write.mockRestore());
      const polling = poller.pollOnce(); await writing.promise;
      expect(store.listItems({ limit: 10 }).map(item => item.id)).toEqual(['slack:old']);
      expect(store.getCursor('slack')).toBe(100);
      let stopping: Promise<void> | undefined;
      if (reason === 'generation stopped') stopping = poller.stopProvider('slack'); else revoked = true;
      release.resolve(); await polling; await stopping;
      write.mockRestore();
      expect(store.countItems()).toBe(1); expect(store.getCursor('slack')).toBe(100);
      await store.close();
      const { store: recovered } = await open(dir);
      expect(recovered.listItems({ limit: 10 }).map(item => item.id)).toEqual(['slack:old']);
      expect(recovered.getCursor('slack')).toBe(100);
      expect(poller.snapshotStatuses()[0]?.state).not.toBe('ready');
    });
  }

  test('dedup, captured input and monotonic cursor survive reopen', async () => {
    const { store, dir } = await open();
    const input = row();
    const pending = store.commitTimestampPoll('slack', [input], () => {});
    input.id = 'mutated'; input.receivedAt = 999;
    expect(await pending).toBe(1);
    expect(await store.commitTimestampPoll('slack', [row('slack:new', 100)], () => {})).toBe(0);
    await store.close(); const { store: recovered } = await open(dir);
    expect(recovered.countItems()).toBe(1); expect(recovered.getCursor('slack')).toBe(200);
    expect(recovered.listItems({ limit: 10 })[0]?.id).toBe('slack:new');
  });

  test('failed write and asynchronous fences cannot consume progress', async () => {
    const { store } = await open();
    const write = spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('synthetic disk failure'));
    cleanup.push(() => write.mockRestore());
    await expect(store.commitTimestampPoll('slack', [row()], () => {})).rejects.toThrow('disk failure');
    write.mockRestore();
    await expect(store.commitTimestampPoll('slack', [row()], (async () => {}) as () => void)).rejects.toThrow('synchronous');
    expect(store.countItems()).toBe(0); expect(store.getCursor('slack')).toBe(0);
    expect(await store.commitTimestampPoll('slack', [row()], () => {})).toBe(1);
  });

  test('rebasing preserves other-provider writes and their queued flush', async () => {
    const { store, dir } = await open(); let fences = 0; let flush: Promise<void> | undefined;
    await store.commitTimestampPoll('slack', [row()], () => {
      if (++fences === 2) {
        store.upsertItems([{ ...row('discord:new', 300), provider: 'discord' }]);
        store.advanceCursor('discord', 300); flush = store.flush();
      }
    });
    await flush; expect(fences).toBe(4);
    await store.close(); const { store: recovered } = await open(dir);
    expect(recovered.countItems()).toBe(2);
    expect(recovered.getCursor('slack')).toBe(200); expect(recovered.getCursor('discord')).toBe(300);
  });
});
