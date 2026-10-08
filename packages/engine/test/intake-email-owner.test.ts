import { afterEach, expect, spyOn, test } from 'bun:test';
import { createEmailInboxOwner, type EmailInboxOwnerOptions } from '../sdk/src/platform/intake/providers/email-owner.js';
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
  let allowed = true, sourceAllowed = true;
  const authority = new AbortController();
  const ownerOptions = { account: { host: 'fixture.invalid', port: 993, username: 'synthetic@example.invalid', mailbox: 'INBOX', security: 'tls' },
    service: f.service, getCheckpoint: () => checkpoint, assertCurrent() { if (!allowed) throw new Error('Scope changed'); },
    screening: { authority: { ownerId: 'fixture-local-services', revision: '1', retention: 'ephemeral-no-log', signal: authority.signal, assertCurrent() { if (!sourceAllowed) throw new Error('Source changed'); } },
      proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'fixture-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 500 } } satisfies EmailInboxOwnerOptions;
  const owner = createEmailInboxOwner(ownerOptions);
  cleanups.push(() => owner.close());
  return { ...f, mailOwner: f.owner, owner, ownerOptions, sourceParts, reached, authority,
    revoke() { allowed = false; }, revokeSource() { sourceAllowed = false; }, checkpoint: () => checkpoint,
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

test('eligibility without a committed checkpoint authenticates metadata only with stable observation', async () => {
  const f = await fixture();
  const first = await f.owner.verifyEligibility();
  const second = await f.owner.verifyEligibility();
  expect(first.signal).toBe(second.signal);
  expect(f.checkpoint()).toBeNull();
  expect(f.sourceParts).toEqual([]); expect(f.ingests).toEqual([]);
  expect(f.sockets.slice(0, 2).every(socket => socket.commands.some(command => command.includes('LOGIN '))
    && socket.commands.some(command => command.includes(' EXAMINE '))
    && !socket.commands.some(command => command.includes('FETCH')))).toBe(true);
  expect(() => first.assertCurrent()).not.toThrow();
  await expect(f.owner.assertReadCurrent()).rejects.toThrow('committed');
});

test('canonical same-account credential invalidation revokes eligibility before reauthentication', async () => {
  const f = await fixture();
  const proof = await f.owner.verifyEligibility();
  f.mailOwner!.invalidate();
  expect(proof.signal.aborted).toBe(true);
  expect(() => proof.assertCurrent()).toThrow();
  const next = await f.owner.verifyEligibility();
  expect(next.signal).not.toBe(proof.signal);
  expect(f.connections()).toBe(2);
});

test('connection outage preserves prior email eligibility without a committed checkpoint', async () => {
  const f = await fixture({ sockets: [new SnapshotSocket()] });
  const proof = await f.owner.verifyEligibility();
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(false);
  expect(() => proof.assertCurrent()).not.toThrow();
});

test('new UID generation revokes eligibility but can prove a new metadata-only candidate', async () => {
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket({ validity: 9 })] });
  const proof = await f.owner.verifyEligibility();
  const next = await f.owner.verifyEligibility();
  expect(proof.signal.aborted).toBe(true);
  expect(next.signal).not.toBe(proof.signal);
  expect(() => next.assertCurrent()).not.toThrow();
  expect(f.checkpoint()).toBeNull();
});

test('decoded authentication refusal revokes email eligibility and a completed commit fence', async () => {
  class DeniedSocket extends SnapshotSocket {
    override async answer(command: string): Promise<void> {
      if (command.includes(' LOGIN ')) {
        this.feed(`${command.split(' ')[0]} NO [AUTHENTICATIONFAILED] rejected\r\n`);
      } else await super.answer(command);
    }
  }
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket(), new DeniedSocket()] });
  const proof = await f.owner.verifyEligibility();
  await f.seed();
  expect(() => f.owner.adapter.assertCurrent!()).not.toThrow();
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(true);
  expect(() => f.owner.adapter.assertCurrent!()).toThrow();
});

test('source authority assertion revokes email eligibility without waiting for its abort signal', async () => {
  const f = await fixture();
  const proof = await f.owner.verifyEligibility();
  f.revokeSource();
  expect(f.authority.signal.aborted).toBe(false);
  expect(() => proof.assertCurrent()).toThrow();
  expect(proof.signal.aborted).toBe(true);
});

test('stale canonical metadata read cannot restore eligibility after account ABA', async () => {
  const gate = deferred<void>();
  cleanups.push(() => gate.resolve());
  const socket = new SnapshotSocket({ hold: ' SEARCH ', gate: gate.promise });
  const f = await fixture({ sockets: [socket, new SnapshotSocket()] });
  const pending = f.owner.verifyEligibility();
  void pending.catch(() => {});
  await socket.reached.promise;
  f.mailOwner!.invalidate();
  gate.resolve();
  await expect(pending).rejects.toThrow();
  const proof = await f.owner.verifyEligibility();
  expect(() => proof.assertCurrent()).not.toThrow();
});

test('held semantic screening retains eligibility across metadata refresh without advancing progress', async () => {
  const gate = deferred<void>(); cleanups.push(() => gate.resolve());
  const f = await fixture({ gate: gate.promise });
  const proof = await f.owner.verifyEligibility();
  await f.seed();
  const pending = f.owner.adapter.poll({ limit: 2, checkpoint: f.checkpoint()! });
  await f.reached.promise;
  const refreshed = await f.owner.verifyEligibility();
  expect(refreshed.signal).toBe(proof.signal);
  expect(() => proof.assertCurrent()).not.toThrow();
  expect(f.checkpoint()!.lastTerminalUid).toBeNull();
  gate.resolve();
  expect((await pending).state).toBe('ready');
});

test('a completed but suspended seed cannot restore commit authority after concurrent authentication denial', async () => {
  class DeniedSocket extends SnapshotSocket {
    override async answer(command: string): Promise<void> {
      if (command.includes(' LOGIN ')) this.feed(`${command.split(' ')[0]} NO [AUTHENTICATIONFAILED] rejected\r\n`);
      else await super.answer(command);
    }
  }
  const f = await fixture({ sockets: [new SnapshotSocket(), new SnapshotSocket(), new DeniedSocket()] });
  const proof = await f.owner.verifyEligibility();
  const reached = deferred<void>(), finish = deferred<void>();
  cleanups.push(() => finish.resolve());
  const actual = f.service.readInboxPage.bind(f.service);
  let held = false;
  const replacement = spyOn(f.service, 'readInboxPage').mockImplementation(async input => {
    const result = await actual(input);
    if (!held) { held = true; reached.resolve(); await finish.promise; }
    return result;
  });
  cleanups.push(() => { replacement.mockRestore(); });
  const pending = f.owner.adapter.poll({ limit: 2 });
  await reached.promise;
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(true);
  finish.resolve();
  expect(await pending).toMatchObject({ state: 'unavailable', items: [] });
  expect(() => f.owner.adapter.assertCurrent!()).toThrow();
});

test('eligibility detaches account, mailbox and service options while canonical metadata is pending', async () => {
  const gate = deferred<void>(); cleanups.push(() => gate.resolve());
  const socket = new SnapshotSocket({ hold: ' SEARCH ', gate: gate.promise });
  const f = await fixture({ sockets: [socket, new SnapshotSocket()] });
  const replacement = snapshotFixture();
  cleanups.push(() => replacement.owner?.dispose());
  const original = f.ownerOptions.account;
  const scope = f.owner.scopeId;
  const pending = f.owner.verifyEligibility();
  void pending.catch(() => {});
  await socket.reached.promise;
  original.host = 'foreign.invalid'; original.username = 'foreign@example.invalid'; original.mailbox = 'FOREIGN';
  f.ownerOptions.account = { host: 'retarget.invalid', port: 993, username: 'retarget@example.invalid', mailbox: 'RETARGET', security: 'tls' };
  f.ownerOptions.service = replacement.service;
  f.ownerOptions.assertCurrent = () => { throw new Error('Replacement options must not run'); };
  f.ownerOptions.getCheckpoint = () => { throw new Error('Eligibility must not inspect checkpoint'); };
  gate.resolve();
  const proof = await pending;
  expect(f.owner.account).toEqual({ host: 'fixture.invalid', port: 993, username: 'synthetic@example.invalid', mailbox: 'INBOX', security: 'tls' });
  expect(Object.isFrozen(f.owner.account)).toBe(true); expect(f.owner.scopeId).toBe(scope);
  expect(() => proof.assertCurrent()).not.toThrow();
  await f.owner.verifyEligibility();
  expect(f.connections()).toBe(2); expect(replacement.connections()).toBe(0);
  expect(socket.commands.some(command => command.includes(' EXAMINE INBOX'))).toBe(true);
  expect(socket.commands.some(command => command.includes('FOREIGN') || command.includes('RETARGET') || command.includes('FETCH'))).toBe(false);
  expect(f.checkpoint()).toBeNull(); expect(f.sourceParts).toEqual([]);
  f.config['email.mailbox'] = 'RETARGET';
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(true);
});
