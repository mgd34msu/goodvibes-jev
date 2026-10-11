import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createInboundMailSourceFactory, type InboundMailSourceFactoryDeps } from '../sdk/src/platform/email/inbound/source-factory.js';
import { InboundMailboxWatcher } from '../sdk/src/platform/email/inbound/watcher.js';
import { InboundMailSupervisor, type InboundMailSupervisorDeps } from '../sdk/src/platform/email/inbound/supervisor.js';
import { resolveWatcherSettings, type MailboxCursorPort, type MailboxConnection, type WatcherClock } from '../sdk/src/platform/email/inbound/ports.js';
import { DedupingInboundMailSink, createInboundMailDedup } from '../sdk/src/platform/email/inbound/sink.js';
import { imapMessageFixture, waitFor } from './_helpers/inbound-watcher-harness.js';

class Wire extends EventEmitter {
  readonly commands: string[] = [];
  closed = false;
  constructor(private readonly holdLogin = false) { super(); }
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.commands.push(command); const tag = command.split(' ')[0];
    if (this.holdLogin && command.includes(' LOGIN ')) { done(); return true; }
    const prefix = command.includes(' EXAMINE ') ? '* 0 EXISTS\r\n* OK [UIDVALIDITY 7]\r\n* OK [UIDNEXT 1]\r\n'
      : command.includes(' CAPABILITY') ? '* CAPABILITY IMAP4rev1\r\n' : command.includes(' SEARCH ') ? '* SEARCH\r\n' : '';
    this.emit('data', Buffer.from(`${prefix}${tag} OK done\r\n`)); done(); return true;
  }
  destroy(): this { if (!this.closed) { this.closed = true; this.emit('close'); } return this; }
}
const clock: WatcherClock = { now: () => 0, sleep: async (_ms, signal) => {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
} };
function cursorPort() {
  const resolved: string[] = []; const advanced: number[] = [];
  const port: MailboxCursorPort = {
    get: async () => null,
    resolve: async input => {
      resolved.push(input.account);
      return { kind: 'resumed', skippedMessageCount: 0, cursor: { account: input.account, mailbox: input.mailbox,
        uidValidity: input.serverUidValidity, lastSeenUid: 0, updatedAt: '2026-01-01T00:00:00Z' } };
    },
    advance: async input => { advanced.push(input.lastSeenUid); return { account: input.account, mailbox: input.mailbox,
      uidValidity: input.uidValidity, lastSeenUid: input.lastSeenUid, updatedAt: '2026-01-01T00:00:00Z' }; },
  };
  return { port, resolved, advanced };
}
function emptySink() { return new DedupingInboundMailSink({ dedup: createInboundMailDedup(60_000), handle: async () => {} }); }
function harness(holdFirstLogin = false) {
  const values: Record<string, unknown> = { 'surfaces.email.imap.host': 'host-a.example.test', 'surfaces.email.user': 'a@example.test',
    'surfaces.email.imap.mailbox': 'INBOX', 'surfaces.email.inbound.accounts': ['a'], 'surfaces.email.inbound.enabled': true,
    'surfaces.email.inbound.source': 'imap', 'surfaces.email.inbound.onInsufficientCapability': 'refuse-and-notify' };
  let configGeneration = 1; let secretGeneration = 1;
  const configListeners = new Set<() => void>(); const secretListeners = new Set<() => void>();
  const wires: Wire[] = []; const cursors = cursorPort();
  const deps: InboundMailSourceFactoryDeps = {
    getConfig: key => values[key], getConfigurationIncarnation: () => configGeneration,
    onDidChangeConfiguration: listener => { configListeners.add(listener); return () => { configListeners.delete(listener); }; },
    secrets: { get: async () => 'synthetic', getCredentialMutationState: () => ({ generation: secretGeneration, pending: false }),
      onDidInvalidateCredentials: listener => { secretListeners.add(listener); return () => { secretListeners.delete(listener); }; } },
    transport: { connectImapTls: async () => {
      const wire = new Wire(holdFirstLogin && wires.length === 0); wires.push(wire); setImmediate(() => wire.emit('data', Buffer.from('* OK synthetic\r\n')));
      return wire as unknown as Socket;
    } },
    cursors: cursors.port as InboundMailSourceFactoryDeps['cursors'], settings: resolveWatcherSettings({ account: 'a', mailbox: 'INBOX', mode: 'poll' }),
    clock, random: () => 0,
  };
  return { deps, wires, cursors, changeAccount: () => {
    values['surfaces.email.user'] = 'b@example.test'; values['surfaces.email.imap.host'] = 'host-b.example.test';
    values['surfaces.email.inbound.accounts'] = ['b']; configGeneration++;
    for (const listener of [...configListeners]) listener();
  }, rotateCredential: () => { secretGeneration++; for (const listener of [...secretListeners]) listener(); } };
}

describe('actual IMAP source lifetime', () => {
  test('same-account reconnect survives; switched account cannot reuse the old factory cursor/sink identity', async () => {
    const h = harness(); const factory = createInboundMailSourceFactory(h.deps);
    const source = await factory.create({ kind: 'imap', account: 'a', mailbox: 'INBOX', sink: emptySink(), observer: {} });
    expect(source).not.toBeNull(); const shutdown = new AbortController();
    await source!.start(shutdown.signal); const running = source!.run(shutdown.signal);
    await waitFor(() => h.wires[0]!.commands.some(command => command.includes(' SEARCH ')), 'first empty drain');
    h.wires[0]!.destroy();
    await waitFor(() => h.wires.length === 2 && h.wires[1]!.commands.some(command => command.includes(' SEARCH ')), 'same-account reconnect');
    expect(h.cursors.resolved).toEqual(['a', 'a']);
    h.changeAccount(); await running;
    expect(source!.retired).toBe(true);
    source!.recheckNow?.();
    expect(await factory.create({ kind: 'imap', account: 'a', mailbox: 'INBOX', sink: emptySink(), observer: {} })).toBeNull();
    expect(h.wires).toHaveLength(2);
    const replacement = await createInboundMailSourceFactory(h.deps).create({ kind: 'imap', account: 'b', mailbox: 'INBOX', sink: emptySink(), observer: {} });
    try {
      await replacement!.start(shutdown.signal);
      expect(h.cursors.resolved.at(-1)).toBe('b');
      expect(h.wires[2]!.commands.find(command => command.includes(' LOGIN '))).toContain('b@example.test');
      expect(h.wires.slice(0, 2).every(wire => wire.commands.every(command => !command.includes('b@example.test')))).toBe(true);
    } finally { await replacement!.stop(); await source!.stop(); }
  });

  test('real supervisor rebuilds a retired source after same-account credential rotation', async () => {
    const h = harness(); const factory = createInboundMailSourceFactory(h.deps); let created = 0;
    const supervisor = new InboundMailSupervisor({
      config: { get: h.deps.getConfig }, account: 'a', mailbox: 'INBOX',
      sources: { create: (input: Parameters<ReturnType<typeof createInboundMailSourceFactory>['create']>[0]) => { created++; return factory.create(input); } },
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors: h.deps.cursors, records: {}, expectations: { hydrate: async () => {} }, expectationPolicy: {},
      housekeeper: { runRecoverySweep: async () => {} }, handle: async () => {},
    } as unknown as InboundMailSupervisorDeps);
    try {
      await supervisor.start(); h.rotateCredential(); supervisor.recheckNow();
      await waitFor(() => created === 2 && h.wires.length === 2 && supervisor.status.running, 'rebuilt same-account source');
      expect(h.cursors.resolved).toEqual(['a', 'a']);
      expect(h.wires[0]!.closed).toBe(true);
    } finally { await supervisor.stop(); }
  });

  test('credential retirement during initial LOGIN queues one replacement and never publishes retired running status', async () => {
    const h = harness(true); const factory = createInboundMailSourceFactory(h.deps); let created = 0;
    const supervisor = new InboundMailSupervisor({
      config: { get: h.deps.getConfig }, account: 'a', mailbox: 'INBOX',
      sources: { create: (input: Parameters<typeof factory.create>[0]) => { created++; return factory.create(input); } },
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors: h.deps.cursors, records: {}, expectations: { hydrate: async () => {} }, expectationPolicy: {},
      housekeeper: { runRecoverySweep: async () => {} }, handle: async () => {},
    } as unknown as InboundMailSupervisorDeps);
    try {
      const initial = supervisor.start();
      await waitFor(() => h.wires[0]?.commands.some(command => command.includes(' LOGIN ')) === true, 'pending first LOGIN');
      h.rotateCredential(); supervisor.recheckNow(); supervisor.recheckNow();
      expect((await initial).running).toBe(false);
      await waitFor(() => created === 2 && h.wires.length === 2 && supervisor.status.running, 'one rebuilt source after initial retirement');
      expect(created).toBe(2); expect(h.wires[0]!.closed).toBe(true);
      expect(h.cursors.resolved).toEqual(['a']);
    } finally { await supervisor.stop(); }
  });

  test('local refusal lease retirement after settlement remains an operational reconnect', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    const port: JudgmentPort = { ...fake.port,
      async ask(request) { return { ...await fake.port.ask(request), decisionId: 'synthetic-local-reading' }; },
      recorder: { recordReadings() {}, recordAction() {
        // First turn lets classifyLocalFailure construct its value; the second
        // retires it before handleUnexpectedFailure consumes the outer await.
        queueMicrotask(() => queueMicrotask(() => installJudgmentPort(fakePort(() => noulAnswer(0.01)).port)));
      } },
    };
    const previous = installJudgmentPort(port); let pauses = 0; let reached!: () => void;
    const recovering = new Promise<void>(resolve => { reached = resolve; });
    const terminals: unknown[] = [];
    const watcher = new InboundMailboxWatcher({ settings: resolveWatcherSettings({ account: 'a', mailbox: 'INBOX', mode: 'poll' }),
      connections: { open: async () => ({
        report: { advertisedCapabilities: [], idle: { known: false }, mailbox: { name: 'INBOX', exists: 0, uidValidity: 7, uidNext: 1, readOnly: true } },
        bodyCapability: { outcome: 'unproven', detail: 'empty' },
        get reader(): never { throw new Error('Unexpected reader access'); },
        get wire(): never { throw new Error('Unexpected wire access'); },
        close: async () => {},
      } satisfies MailboxConnection) },
      cursors: { ...cursorPort().port, resolve: async () => { throw new Error('Unexpected local state failure'); } },
      sink: emptySink(), random: () => 0, observer: { terminalFailure: failure => { terminals.push(failure); } },
      clock: { now: () => 0, sleep: async (_ms, signal) => {
        pauses++; if (pauses < 10) return; reached();
        if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
      } },
    });
    watcher.start(); const settled = watcher.whenSettled().catch(error => error as unknown);
    try {
      await recovering;
      expect(terminals).toEqual([]); expect(watcher.status.verdict.reason).toBe('reconnecting');
      expect(watcher.status.running).toBe(true);
    } finally { await watcher.stop(); await settled; installJudgmentPort(previous); }
  });

  test('buffered envelopes cannot deliver or advance after retirement during first delivery', async () => {
    const lifetime = new AbortController(); const cursors = cursorPort(); const delivered: number[] = [];
    let release!: () => void; let started!: () => void;
    const first = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const connection: MailboxConnection = {
      reading: { signal: lifetime.signal }, report: { advertisedCapabilities: ['IMAP4REV1'], idle: { known: true, supported: false },
        mailbox: { name: 'INBOX', exists: 0, uidValidity: 7, uidNext: 1, readOnly: true } },
      bodyCapability: { outcome: 'unproven', detail: 'Empty at open.' },
      reader: { capabilities: async () => ['IMAP4REV1'], fetchEnvelopes: async () => [],
        fetchEnvelopeBatch: async () => ({ envelopes: [imapMessageFixture({ uid: 1 }).envelope, imapMessageFixture({ uid: 2 }).envelope], unreadable: [] }) },
      wire: { sendCommand: async () => 'A1', awaitTag: async () => ['* SEARCH 1 2'], sendRawLine: async () => {},
        awaitContinuation: async () => {}, onUntagged: () => () => {}, waitForUntagged: async () => '* 0 EXISTS' },
      close: async () => {},
    };
    const watcher = new InboundMailboxWatcher({ settings: resolveWatcherSettings({ account: 'a', mailbox: 'INBOX', mode: 'poll' }),
      reading: { signal: lifetime.signal }, connections: { open: async () => connection }, cursors: cursors.port,
      sink: { deliver: async message => { if (message.source === 'imap') delivered.push(message.uid); started(); await gate; } }, clock, random: () => 0 });
    watcher.start(); await first; lifetime.abort(); release(); await watcher.whenSettled();
    expect(delivered).toEqual([1]); expect(cursors.advanced).toEqual([]); await watcher.stop();
  });
});
