import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { installJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { ImapClient } from '../sdk/src/platform/email/imap-client.js';
import { classifyServerRefusal, composeOpenFailure, ImapOpenError } from '../sdk/src/platform/email/imap-open.js';
import { ImapReadingError } from '../sdk/src/platform/email/imap-readings.js';
import { selectDraftsMailbox } from '../sdk/src/platform/email/imap-draft.js';
import { ImapBodyCapabilityError, probeMailboxBody } from '../sdk/src/platform/email/imap-body-probe.js';
import { classifyLocalFailure, classifyReadFailure, classifyOpenFailure } from '../sdk/src/platform/email/inbound/capability.js';
import { imapMailboxConnectionPort } from '../sdk/src/platform/email/inbound/connection.js';
import { beginImapSourceReading } from '../sdk/src/platform/email/inbound/imap-source-lifetime.js';
import type { InboundMailSourceFactoryDeps } from '../sdk/src/platform/email/inbound/source-factory.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const refusal = (text = 'La demande a échoué.') => new Error(`IMAP command failed: A1 NO ${text}`);
const draft = { from: 'a@example.test', to: 'b@example.test', subject: 'synthetic', body: 'synthetic' };
function facts(yes: readonly string[] = [], probability = 0.99) {
  return fakePort(name => noulAnswer(yes.includes(name) ? probability : 1 - probability));
}
function selection(chosen: string = 'mailbox_0', confidence = 0.99, fits = true) {
  return fakePort((name, question) => name === 'pick' ? choiceAnswer(question, chosen, confidence)
    : noulAnswer(fits && name === `fits_${chosen.split('_')[1]}` ? 0.99 : 0.01));
}
function held(port: JudgmentPort) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const asks: Parameters<JudgmentPort['ask']>[0][] = [];
  const wrapped: JudgmentPort = { model: port.model, async ask(request) {
    asks.push(request); began(); await gate; return port.ask(request);
  } };
  return { port: wrapped, started, release, asks };
}

/** Byte-only in-memory IMAP. APPEND is observed, never sent to an external service. */
class Wire extends EventEmitter {
  readonly commands: string[] = [];
  closed = false;
  reply: (command: string) => string = command => `${command.split(' ')[0]} OK done\r\n`;
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.commands.push(command);
    const response = this.reply(command);
    if (response) this.emit('data', Buffer.from(response));
    done(); return true;
  }
  destroy(): this { if (!this.closed) { this.closed = true; this.emit('close'); } return this; }
  socket(): Socket { return this as unknown as Socket; }
  greeting(): void { this.emit('data', Buffer.from('* OK synthetic\r\n')); }
}
function makeClient(options: JudgmentReadingOptions = {}, onCommand?: (command: string) => string) {
  const wire = new Wire();
  if (onCommand) wire.reply = onCommand;
  const client = new ImapClient({ socket: wire.socket(), username: 'synthetic', password: 'synthetic', timeoutMs: 200, ...options });
  return { wire, client };
}
async function opened(options: JudgmentReadingOptions = {}, list = '* LIST () "/" "Brouillons"\r\n') {
  const pair = makeClient(options, command => {
    const tag = command.split(' ')[0];
    if (command.includes(' LIST ')) return `${list}${tag} OK done\r\n`;
    return `${tag} OK done\r\n`;
  });
  const work = pair.client.open(); pair.wire.greeting(); await work; return pair;
}

describe('IMAP semantic refusal boundary', () => {
  test.each([
    ...['LIMIT', 'INUSE', 'UNAVAILABLE', 'SERVERBUG', 'CONTACTADMIN', 'OVERQUOTA'].map(code => [code, 'server-unavailable'] as const),
    ...['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED', 'PRIVACYREQUIRED'].map(code => [code, 'authentication-rejected'] as const),
    ...['NONEXISTENT', 'TRYCREATE'].map(code => [code, 'mailbox-unavailable'] as const),
  ])('RFC %s is exact and needs no judgment', async (code, reason) => {
    expect(await classifyServerRefusal(`IMAP command failed: A1 NO [${code}] password=synthetic-private`, 'authentication-rejected')).toBe(reason);
  });

  test('localized meaning comes only from the battery, with original complete text', async () => {
    const fake = facts(['mailbox']); installJudgmentPort(fake.port);
    expect(await classifyServerRefusal('Boîte inexistante.', 'authentication-rejected')).toBe('mailbox-unavailable');
    expect(fake.requests[0]?.state).toEqual({ message: 'Boîte inexistante.' });
    expect(Object.keys(fake.requests[0]!.questions)).toEqual(['server', 'credential', 'mailbox']);
  });

  test('all settled no preserves phase rules; keyword text supplies no fallback', async () => {
    installJudgmentPort(facts().port);
    expect(await classifyServerRefusal('Invalid password. No such mailbox. Try again.', 'authentication-rejected')).toBe('server-unavailable');
    expect((await classifyReadFailure(refusal('Invalid password'), 'search')).verdict.reason).toBe('reconnecting');
    expect((await classifyReadFailure(refusal('Invalid password'), 'fetch')).verdict.reason).toBe('fetch-refused');
  });

  test.each([undefined, 'weak', 'malformed', 'throws'] as const)('%s reading never fabricates a terminal body/account verdict', async mode => {
    if (mode === 'weak') installJudgmentPort(facts(['credential'], 0.65).port);
    if (mode === 'malformed') installJudgmentPort(fakePort(() => noulAnswer(2)).port);
    if (mode === 'throws') installJudgmentPort({ model: 'jev-1.13.0', ask: async () => { throw new Error('password=never-diagnose'); } });
    const error = await probeMailboxBody({ command: async () => { throw refusal(); } }, { exists: 1, mailbox: 'INBOX' }).catch(error => error as unknown);
    expect(error).toBeInstanceOf(ImapReadingError);
    expect(error).not.toBeInstanceOf(ImapBodyCapabilityError);
    expect(String(error)).not.toContain('never-diagnose');
    await expect(classifyReadFailure(refusal(), 'fetch')).rejects.toBeInstanceOf(ImapReadingError);
  });

  test('complete protected failure is screened before any request or diagnostics', async () => {
    const fake = facts(['credential']); installJudgmentPort(fake.port);
    const message = `${'ordinary explanation '.repeat(3000)} password=synthetic-private`;
    await expect(composeOpenFailure({ refusedReason: 'authentication-rejected', refusedSummary: 'Rejected.', error: refusal(message), mailbox: 'INBOX' })).rejects.toBeInstanceOf(ImapReadingError);
    expect(fake.requests).toHaveLength(0);
    const known = await composeOpenFailure({ refusedReason: 'authentication-rejected', refusedSummary: 'Rejected.', error: refusal('[AUTHENTICATIONFAILED] password=synthetic-private'), mailbox: 'INBOX' });
    expect(known).toBeInstanceOf(ImapOpenError);
    expect(JSON.stringify(known)).not.toContain('synthetic-private');
    expect(known.message).not.toContain('synthetic-private');
  });

  test.each(['cancel', 'session', 'authority', 'port-ABA'] as const)('actual open retires late reading on %s', async mode => {
    const pending = held(facts(['credential']).port); installJudgmentPort(pending.port);
    const controller = new AbortController(); let current = true;
    const pair = makeClient({ signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('private old account'); } }, command => `${command.split(' ')[0]} NO vague refusal\r\n`);
    const work = pair.client.open().catch(error => error as unknown); pair.wire.greeting(); await pending.started;
    if (mode === 'cancel') controller.abort();
    if (mode === 'session') pair.client.close();
    if (mode === 'authority') current = false;
    if (mode === 'port-ABA') { installJudgmentPort(facts().port); installJudgmentPort(pending.port); }
    pending.release();
    expect(await work).toBeInstanceOf(ImapReadingError);
    expect(pair.wire.commands.some(command => command.includes(' EXAMINE '))).toBe(false);
    expect(pair.client.mailboxStatus).toBeNull(); pair.client.close();
  });

  test('inbound connection open cancellation interrupts a non-cooperating reading', async () => {
    const pending = held(facts(['credential']).port); installJudgmentPort(pending.port);
    const wire = new Wire(); wire.reply = command => `${command.split(' ')[0]} NO vague\r\n`;
    const controller = new AbortController();
    const work = imapMailboxConnectionPort({ connect: async () => wire.socket(), username: 'synthetic', password: 'synthetic', mailbox: 'INBOX' })
      .open({ signal: controller.signal }).catch(error => error as unknown);
    await tick(); wire.greeting(); await pending.started; controller.abort();
    expect(await work).toBeInstanceOf(ImapReadingError);
    expect(wire.closed).toBe(true); pending.release();
  });

  test('body probe maps known refusal to its typed notice rather than re-reading it', async () => {
    const error = await probeMailboxBody({ command: async () => { throw refusal('[LIMIT] private'); } }, { exists: 1, mailbox: 'INBOX' }).catch(error => error as unknown);
    expect(error).toMatchObject({ reason: 'server-unavailable', terminal: false, serverMessage: '' });
  });

  test('actual body probe timeout remains a nonterminal connection failure without a reading', async () => {
    const fake = facts(['credential']); installJudgmentPort(fake.port);
    const { client, wire } = makeClient({}, command => {
      const tag = command.split(' ')[0];
      if (command.includes(' EXAMINE ')) return `* 1 EXISTS\r\n${tag} OK done\r\n`;
      if (command.includes(' FETCH ')) return '';
      return `${tag} OK done\r\n`;
    });
    try {
      const opening = client.open(); wire.greeting(); await opening;
      const error = await client.probeBodyReadable().catch(error => error as unknown);
      expect(error).toMatchObject({ reason: 'connection-failed', terminal: false, serverMessage: '' });
      expect(fake.requests).toHaveLength(0);
    } finally { client.close(); }
  });

  test('actual body probe cannot publish a late capability claim after connection retirement', async () => {
    const pending = held(facts().port); installJudgmentPort(pending.port);
    const { client, wire } = makeClient({}, command => {
      const tag = command.split(' ')[0];
      if (command.includes(' EXAMINE ')) return `* 1 EXISTS\r\n${tag} OK done\r\n`;
      if (command.includes(' FETCH ')) return `${tag} NO vague\r\n`;
      return `${tag} OK done\r\n`;
    });
    const opening = client.open(); wire.greeting(); await opening;
    const work = client.probeBodyReadable().catch(error => error as unknown); await pending.started;
    client.close();
    expect(await work).toBeInstanceOf(ImapReadingError); pending.release();
  });

  test('a settled refusal carries its original owner through later verdict consumption', async () => {
    const port = facts(['credential']).port; installJudgmentPort(port);
    const verdict = await classifyReadFailure(refusal(), 'fetch');
    const failure = await composeOpenFailure({ refusedReason: 'authentication-rejected', refusedSummary: 'Refused.', error: refusal(), mailbox: 'INBOX' });
    installJudgmentPort(facts().port); installJudgmentPort(port);
    expect(() => verdict.assertCurrent?.()).toThrow();
    expect(classifyOpenFailure(failure).terminal).toBe(false);
  });

  test('local cursor validation is not mistaken for a failed state write', async () => {
    const fake = facts(); installJudgmentPort(fake.port);
    expect((await classifyLocalFailure(new Error('cursor validation failed'), 10, 10)).verdict.reason).toBe('watcher-stopped-unexpectedly');
    expect(fake.requests).toHaveLength(1);
    installJudgmentPort(undefined);
    expect((await classifyLocalFailure(Object.assign(new Error('private'), { code: 'EACCES' }), 1, 10)).verdict.reason).toBe('local-store-unwritable');
  });
});

describe('IMAP drafts selection boundary', () => {
  test('special-use and NoSelect are structural, even with localized names', async () => {
    expect(await selectDraftsMailbox(['* LIST (\\NoSelect \\Drafts) "/" "wrong"', '* LIST (\\Drafts) "/" "Entwürfe"'])).toBe('Entwürfe');
  });
  test('candidate reading chooses a localized exact offered identity', async () => {
    const fake = selection('mailbox_1'); installJudgmentPort(fake.port);
    expect(await selectDraftsMailbox(['* LIST () "/" "Documents/Drafts"', '* LIST () "/" "Brouillons"'])).toBe('Brouillons');
    expect(fake.requests[0]?.context?.pattern).toBe('select');
  });
  test('ambiguous names and none cannot trigger default APPEND', async () => {
    installJudgmentPort(selection('none').port);
    const { client, wire } = await opened({}, '* LIST () "/" "Account A/Drafts"\r\n* LIST () "/" "Account B/Drafts"\r\n');
    try { await expect(client.appendDraft(draft)).rejects.toBeInstanceOf(ImapReadingError);
      expect(wire.commands.some(command => command.includes(' APPEND '))).toBe(false);
    } finally { client.close(); }
  });
  test.each(['missing', 'weak', 'unfit', 'malformed'] as const)('%s selection cannot trigger APPEND', async mode => {
    if (mode === 'weak') installJudgmentPort(selection('mailbox_0', 0.6).port);
    if (mode === 'unfit') installJudgmentPort(selection('mailbox_0', 0.99, false).port);
    if (mode === 'malformed') installJudgmentPort(fakePort(() => ({ type: 'choice', choice: 'unoffered' })).port);
    const { client, wire } = await opened();
    try { await expect(client.appendDraft(draft)).rejects.toBeInstanceOf(ImapReadingError);
      expect(wire.commands.some(command => command.includes(' APPEND '))).toBe(false);
    } finally { client.close(); }
  });
  test('complete LIST input is screened before discarded entries or names transmit', async () => {
    const fake = selection(); installJudgmentPort(fake.port);
    await expect(selectDraftsMailbox(['* LIST () "/" "Brouillons"', `unparsed ${'x'.repeat(6000)} password=synthetic-private`])).rejects.toBeInstanceOf(ImapReadingError);
    expect(fake.requests).toHaveLength(0);
  });
  test.each(['owner', 'port', 'current-check'] as const)('post-selection %s retirement cannot send a draft literal after delayed continuation', async mode => {
    const port = selection().port; installJudgmentPort(port);
    const controller = new AbortController(); let current = true;
    let appendStarted!: () => void;
    const started = new Promise<void>(resolve => { appendStarted = resolve; });
    const { client, wire } = makeClient({ signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('retired'); } }, command => {
      const tag = command.split(' ')[0];
      if (command.includes(' LIST ')) return `* LIST () "/" "Brouillons"\r\n${tag} OK done\r\n`;
      if (command.includes(' APPEND ')) { appendStarted(); return ''; }
      return `${tag} OK done\r\n`;
    });
    const opening = client.open(); wire.greeting(); await opening;
    const work = client.appendDraft(draft).catch(error => error as unknown); await started;
    if (mode === 'owner') controller.abort();
    if (mode === 'port') { installJudgmentPort(facts().port); installJudgmentPort(port); }
    if (mode === 'current-check') current = false;
    wire.emit('data', Buffer.from('+ continue\r\n'));
    expect(await work).toBeInstanceOf(Error);
    expect(wire.commands.some(command => command.includes('Subject: synthetic'))).toBe(false);
    expect(wire.closed).toBe(true);
    client.close();
  });

  test.each(['cancel', 'close', 'account'] as const)('actual APPEND selection is fenced by %s', async mode => {
    const pending = held(selection().port); installJudgmentPort(pending.port);
    const controller = new AbortController(); let current = true;
    const { client, wire } = await opened({ signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('changed'); } });
    const work = client.appendDraft(draft).catch(error => error as unknown); await pending.started;
    if (mode === 'cancel') controller.abort();
    if (mode === 'close') client.close();
    if (mode === 'account') current = false;
    pending.release();
    expect(await work).toBeInstanceOf(ImapReadingError);
    expect(wire.commands.some(command => command.includes(' APPEND '))).toBe(false); client.close();
  });
});

describe('inbound account and policy owner', () => {
  test.each(['config-ABA', 'credential-ABA', 'policy'] as const)('%s retires in-flight semantic work', async mode => {
    let configGeneration = 1; let secretGeneration = 1; let policy = 'refuse-and-notify';
    let configChange = () => {}; let secretChange = () => {};
    const deps: InboundMailSourceFactoryDeps = {
      get transport(): never { throw new Error('Unexpected transport access'); },
      get cursors(): never { throw new Error('Unexpected cursor access'); },
      get settings(): never { throw new Error('Unexpected settings access'); },
      getConfig: (key: string) => key === 'surfaces.email.inbound.onInsufficientCapability' ? policy : undefined,
      getConfigurationIncarnation: () => configGeneration,
      onDidChangeConfiguration: (listener: () => void) => { configChange = listener; return () => {}; },
      secrets: { get: async () => null, getCredentialMutationState: () => ({ generation: secretGeneration, pending: false }),
        onDidInvalidateCredentials: (listener: () => void) => { secretChange = listener; return () => {}; } },
    };
    const owner = beginImapSourceReading(deps, {});
    const pending = held(facts(['credential']).port); installJudgmentPort(pending.port);
    const work = classifyReadFailure(refusal(), 'fetch', owner.reading).catch(error => error as unknown); await pending.started;
    if (mode === 'config-ABA') { configGeneration++; configChange(); configGeneration++; }
    if (mode === 'credential-ABA') { secretGeneration++; secretChange(); secretGeneration++; }
    if (mode === 'policy') policy = 'notice-only';
    pending.release(); expect(await work).toBeInstanceOf(ImapReadingError); owner.dispose();
  });
});
