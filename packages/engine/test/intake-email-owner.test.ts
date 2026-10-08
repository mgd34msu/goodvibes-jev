import { afterEach, expect, test } from 'bun:test';
import { createEmailInboxOwner } from '../sdk/src/platform/intake/providers/email-owner.js';
import type { ImapUidCheckpoint } from '../sdk/src/platform/intake/provider-adapter.js';
import { SnapshotSocket, snapshotFixture } from './_helpers/mail-inbox-snapshot.js';
import { deferred, tick } from './_helpers/mail-subject-source.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(options: { gate?: Promise<void>; sockets?: SnapshotSocket[]; redaction?: boolean } = {}) {
  const sourceParts: string[][] = [];
  const reached = deferred<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { messages?: { content: string }[] };
    if (new URL(request.url).pathname.endsWith('/chat/completions')) {
      const source = JSON.parse(body.messages![1]!.content) as { revision: string; parts: string[] };
      sourceParts.push(source.parts); reached.resolve(); await options.gate;
      const spans = options.redaction ? source.parts.flatMap((text, part) => {
        const start = text.indexOf('Synthetic'); return start < 0 ? [] : [{ part, start, end: start + 9 }];
      }) : [];
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ revision: source.revision, spans }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => server.stop(true));
  const f = snapshotFixture({ sockets: options.sockets ?? Array.from({ length: 6 }, () => new SnapshotSocket()) });
  let checkpoint: ImapUidCheckpoint | null = null;
  let allowed = true;
  const authority = new AbortController();
  const owner = createEmailInboxOwner({ account: { host: 'fixture.invalid', port: 993, username: 'synthetic@example.invalid', mailbox: 'INBOX', security: 'tls' },
    service: f.service, getCheckpoint: () => checkpoint, assertCurrent() { if (!allowed) throw new Error('Scope changed'); },
    screening: { authority: { ownerId: 'fixture-local-services', revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() {} },
      proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'fixture-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 500 } });
  cleanups.push(() => owner.close());
  return { ...f, mailOwner: f.owner, owner, sourceParts, reached, authority,
    revoke() { allowed = false; }, checkpoint: () => checkpoint,
    async seed() { const result = await owner.adapter.poll({ limit: 2 }); checkpoint = result.checkpointAdvance!.next; return result; },
    commit(next: ImapUidCheckpoint) { checkpoint = next; } };
}

test('construction is inert; seed is explicit and complete protected messages advance only on next poll', async () => {
  const f = await fixture({ redaction: true }); expect(f.connections()).toBe(0); expect(f.sourceParts).toHaveLength(0);
  const seed = await f.seed(); expect(seed).toMatchObject({ state: 'pending', items: [], checkpointAdvance: { transition: 'seed', next: { lastTerminalUid: null } } });
  expect(f.sourceParts).toHaveLength(0);
  const poll = await f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! });
  expect(poll).toMatchObject({ state: 'ready', items: [{ subjectPreview: 'Subject 42', bodyPreview: '[redacted] body' }, { subjectPreview: 'Subject 43', bodyPreview: '[redacted] body' }] });
  expect(poll.checkpointAdvance?.next.lastTerminalUid).toBe(43);
  expect(poll.checkpointAdvance?.coveredUids).toEqual([42, 43]);
  expect(f.sourceParts).toHaveLength(2);
  expect(f.sourceParts[0]![0]).toContain('Subject: Subject 42'); expect(f.sourceParts[0]![1]).toContain('"TEXT" "PLAIN"');
  expect(f.sourceParts[0]![2]).toBe('Synthetic body');
  expect(poll.items[0]!.id).not.toContain('synthetic@example.invalid'); expect(poll.items[0]!.id).toContain(':0000000007:0000000042');
  expect(() => f.owner.adapter.assertCurrent!()).not.toThrow();
});

test('incomplete source never reaches screening or advances the seeded checkpoint', async () => {
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket({ incompleteBody: true })] }); await f.seed();
  const result = await f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! });
  expect(result.state).toBe('unavailable'); expect(result.checkpointAdvance).toBeUndefined(); expect(f.sourceParts).toHaveLength(0);
  expect(f.checkpoint()!.lastTerminalUid).toBeNull();
});

test('account ABA during held screening aborts source and keeps every UID pending', async () => {
  const gate = deferred<void>(); const f = await fixture({ gate: gate.promise }); await f.seed();
  const pending = f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! }); await f.reached.promise;
  f.config['email.username'] = 'other@example.invalid'; f.mailOwner!.invalidate();
  f.config['email.username'] = 'synthetic@example.invalid'; f.mailOwner!.invalidate();
  gate.resolve();
  const result = await pending; expect(result.state).toBe('unavailable'); expect(result.items).toHaveLength(0);
  expect(result.checkpointAdvance).toBeUndefined();
});

test('read fence requires committed generation and fresh authenticated canonical read', async () => {
  const f = await fixture();
  await expect(f.owner.assertReadCurrent()).rejects.toThrow('committed');
  await f.seed(); const before = f.connections(); await f.owner.assertReadCurrent(); expect(f.connections()).toBe(before + 1);
  f.revoke(); await expect(f.owner.assertReadCurrent()).rejects.toThrow();
});

test('replacement UIDVALIDITY withholds old mirror until explicit reset commits', async () => {
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket({ validity: 9 }), new SnapshotSocket({ validity: 9 }), new SnapshotSocket({ validity: 9 })] });
  await f.seed(); await expect(f.owner.assertReadCurrent()).rejects.toThrow('committed');
  const reset = await f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! });
  expect(reset.checkpointAdvance?.transition).toBe('reset'); expect(reset.checkpointAdvance?.next.lastTerminalUid).toBeNull();
  f.commit(reset.checkpointAdvance!.next); await f.owner.assertReadCurrent();
});

test('close cancels held source work, drains accepted poll and refuses stale admission', async () => {
  const gate = deferred<void>(); const f = await fixture({ gate: gate.promise }); await f.seed();
  const pending = f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! }); await f.reached.promise;
  const close = f.owner.close(); gate.resolve(); await close;
  expect(await pending).toMatchObject({ state: 'unavailable', items: [] });
  expect(f.owner.close()).toBe(close); await tick();
  expect(await f.owner.adapter.poll({ limit: 2 })).toMatchObject({ state: 'unavailable' });
});

test('an in-flight mirror read lease cannot switch to a newly committed UIDVALIDITY', async () => {
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket(), new SnapshotSocket({ validity: 9 }), new SnapshotSocket({ validity: 9 })] });
  await f.seed(); const validate = await f.owner.acquireReadLease();
  const reset = await f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! });
  f.commit(reset.checkpointAdvance!.next);
  await expect(validate()).rejects.toThrow();
});
