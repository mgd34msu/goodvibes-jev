/**
 * Connected-host receipt delivery: a current daemon delivers its undelivered
 * honesty receipts ("updated from X to Y", "restarted after a crash") once, and
 * ONLY to a /status read that opts in with ?receipts=consume, a plain /status
 * read is receipt-neutral. The agent's consuming reader is a single
 * ?receipts=consume read issued once per attach; the liveness probe stays plain.
 * Every consumed receipt must render exactly once.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AgentDaemonReceiptFeed, type DaemonReceipt } from '../../runtime/daemon-receipts.ts';
import { createSessionSpineReceiptConsumer as createSpineReceiptConsumer } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';

describe('AgentDaemonReceiptFeed', () => {
  test('buffers receipts captured before the renderer attaches, then flushes in order', () => {
    const feed = new AgentDaemonReceiptFeed();
    feed.push([{ id: 'a', text: 'first', at: 1 }, { id: 'b', text: 'second', at: 2 }]);
    const delivered: DaemonReceipt[] = [];
    feed.attach((receipt) => delivered.push(receipt));
    expect(delivered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('delivers immediately once attached and dedupes by id', () => {
    const feed = new AgentDaemonReceiptFeed();
    const delivered: DaemonReceipt[] = [];
    feed.attach((receipt) => delivered.push(receipt));
    feed.push([{ id: 'a', text: 'first', at: 1 }]);
    feed.push([{ id: 'a', text: 'first again', at: 1 }, { id: 'b', text: 'second', at: 2 }]);
    expect(delivered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('receipt consumer (?receipts=consume, once per attach)', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('the consumed payload flows through AgentDaemonReceiptFeed to a render sink exactly once', async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        status: 'running',
        version: '1.9.1',
        receipts: [{ id: 'update-1', text: 'updated from 1.9.0 to 1.9.1', at: 9 }],
      }),
    });
    const feed = new AgentDaemonReceiptFeed();
    const consume = createSpineReceiptConsumer({
      resolveConnection: () => ({ baseUrl: `http://127.0.0.1:${server!.port}`, token: 'test-token' }),
    });
    // Mirror services.consumeDaemonReceipts: one consuming read, push to the feed.
    feed.push(await consume());
    feed.push(await consume()); // dedupe by id, a re-consume must not double-render.

    const rendered: string[] = [];
    feed.attach((receipt) => rendered.push(receipt.text));
    expect(rendered).toEqual(['updated from 1.9.0 to 1.9.1']);
  });
});
