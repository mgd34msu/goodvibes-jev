import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ImapClient, parseFetchResponse, decodeHeader, imapDate, type ImapConnector, type ImapSocket } from '../sdk/src/platform/intake/providers/imap-client.js';

const DUMMY_PASSWORD = 'owned-fixture-password';
class MemorySocket extends EventEmitter implements ImapSocket {
  readonly writes: string[] = [];
  destroyed = false;
  reply?: (command: string) => void;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data' && typeof args[0] === 'string') args[0] = Buffer.from(args[0]);
    return super.emit(event, ...args);
  }
  write(command: string): boolean {
    this.writes.push(command);
    queueMicrotask(() => this.reply?.(command));
    return true;
  }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; this.emit('close'); }
    return this;
  }
}

async function opened(reply: (socket: MemorySocket, command: string) => void, timeoutMs = 50) {
  const socket = new MemorySocket();
  socket.reply = command => reply(socket, command);
  const connector: ImapConnector = (_options, ready) => {
    queueMicrotask(() => { ready(); setTimeout(() => socket.emit('data', '* OK fixture ready\r\n'), 0); });
    return socket;
  };
  const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD, timeoutMs }, connector);
  await client.connect();
  return { client, socket };
}

describe('intake IMAP protocol', () => {
  test('takes byte-counted UTF-8 payloads whole and ignores protocol text inside them', async () => {
    const header = 'From: fixture@example.test\r\nSubject: =?UTF-8?Q?caf=C3=A9?=\r\n';
    const body = 'é\r\nA0001 NO forged\r\n* 99 FETCH (UID 999 FLAGS (\\Seen))\r\n你好';
    const { client } = await opened((wire, command) => {
      const tag = command.split(' ')[0];
      const prefix = `* 1 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(header)}}\r\n${header} BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n`;
      wire.emit('data', prefix + body.slice(0, 10));
      setTimeout(() => wire.emit('data', `${body.slice(10)} UID 42 FLAGS ())\r\n${tag} OK complete\r\n`), 1);
    });
    try {
      expect(await client.fetchEnvelopes([42])).toEqual([{ uid: 42, from: 'fixture@example.test', subject: 'café', date: 0, seen: false, bodyPreview: body }]);
    } finally { client.close(); }
  });

  test('retains literal headers and the body preview across a complete FETCH command', async () => {
    const header = 'From: Fixture <person@example.test>\r\nSubject: A useful message\r\nDate: Wed, 30 Sep 2026 12:00:00 +0000\r\n';
    const body = 'Hello from the fixture';
    const { client, socket } = await opened((wire, command) => {
      const tag = command.split(' ')[0];
      wire.emit('data', `* 1 FETCH (UID 42 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(header)}}\r\n${header} BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n${body})\r\n${tag} OK complete\r\n`);
    });
    try {
      const messages = await client.fetchEnvelopes([42]);
      expect(messages).toEqual([{ uid: 42, from: 'Fixture <person@example.test>', subject: 'A useful message', date: Date.UTC(2026, 8, 30, 12), seen: true, bodyPreview: body }]);
      expect(socket.writes[0]).toContain('BODY.PEEK[TEXT]<0.600>');
    } finally { client.close(); }
  });

  test('never includes the LOGIN command or credential in timeout diagnostics', async () => {
    const { client } = await opened(() => undefined, 5);
    try {
      const message = await client.login().then(() => 'unexpected success', (error: Error) => error.message);
      expect(message).toContain('timeout');
      expect(message).not.toContain(DUMMY_PASSWORD);
      expect(message).not.toContain('"fixture"');
    } finally { client.close(); }
  });

  test('refuses credential command separators before sending bytes', async () => {
    const socket = new MemorySocket();
    const connector: ImapConnector = (_options, ready) => {
      queueMicrotask(() => { ready(); setTimeout(() => socket.emit('data', '* OK fixture ready\r\n'), 0); });
      return socket;
    };
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture\r\nA0002 LOGOUT', password: DUMMY_PASSWORD, timeoutMs: 5 }, connector);
    try {
      await client.connect();
      await expect(client.login()).rejects.toThrow();
      expect(socket.writes).toEqual([]);
    } finally { client.close(); }
  });

  test('a server rejection cannot echo a LOGIN password into diagnostics', async () => {
    const { client } = await opened((wire, command) => wire.emit('data', `${command.split(' ')[0]} NO ${DUMMY_PASSWORD}\r\n`));
    try {
      const message = await client.login().then(() => 'unexpected success', (error: Error) => error.message);
      expect(message).toContain('NO');
      expect(message).not.toContain(DUMMY_PASSWORD);
    } finally { client.close(); }
  });

  test('transport errors are value-free and close the owned socket', async () => {
    const { client, socket } = await opened(wire => wire.emit('error', new Error(DUMMY_PASSWORD)));
    const message = await client.login().then(() => 'unexpected success', (error: Error) => error.message);
    expect(message).toContain('transport failed');
    expect(message).not.toContain(DUMMY_PASSWORD);
    expect(socket.destroyed).toBe(true);
  });

  test('an error between commands is observed and closes the owned socket', async () => {
    const { client, socket } = await opened(() => undefined);
    expect(() => socket.emit('error', new Error('fixture disconnect'))).not.toThrow();
    await Promise.resolve();
    expect(socket.destroyed).toBe(true);
    await expect(client.login()).rejects.toThrow('not ready');
  });

  test('commands wait for successful connection readiness', async () => {
    const socket = new MemorySocket();
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD }, () => socket);
    const connecting = client.connect();
    await expect(client.login()).rejects.toThrow('not ready');
    expect(socket.writes).toEqual([]);
    client.close();
    await expect(connecting).rejects.toThrow('closed');
  });

  test('refuses simultaneous commands without writing the second one', async () => {
    const { client, socket } = await opened(() => undefined);
    const first = client.login();
    await expect(client.select()).rejects.toThrow('already in progress');
    expect(socket.writes).toHaveLength(1);
    client.close();
    await expect(first).rejects.toThrow('closed');
    expect(socket.listenerCount('data')).toBe(0);
  });

  test('connect has a deadline even before TLS becomes ready', async () => {
    const socket = new MemorySocket();
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD, timeoutMs: 5 }, () => socket);
    await expect(client.connect()).rejects.toThrow('timeout');
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount('data')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });

  test('close during connection rejects readiness and a late TLS callback cannot reopen it', async () => {
    const socket = new MemorySocket();
    let secure!: () => void;
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD }, (_options, ready) => { secure = ready; return socket; });
    const connecting = client.connect();
    client.close();
    secure();
    await expect(connecting).rejects.toThrow('closed');
    await expect(client.connect()).rejects.toThrow('closed');
    expect(socket.listenerCount('error')).toBe(0);
  });

  test('handles a greeting arriving in the TLS-ready callback turn', async () => {
    const socket = new MemorySocket();
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD }, (_options, ready) => {
      queueMicrotask(() => { ready(); socket.emit('data', '* OK ready\r\n'); });
      return socket;
    });
    try { await expect(client.connect()).resolves.toBeUndefined(); }
    finally { client.close(); }
  });

  test('response bounds count UTF-8 bytes and close the transport', async () => {
    const socket = new MemorySocket();
    const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: DUMMY_PASSWORD, maxResponseBytes: 40 }, (_options, ready) => {
      queueMicrotask(() => { ready(); socket.emit('data', `* OK ${'é'.repeat(20)}\r\n`); });
      return socket;
    });
    await expect(client.connect()).rejects.toThrow('40 bytes');
    expect(socket.destroyed).toBe(true);
  });

  test('validates UIDs and mailbox command values before writing', async () => {
    const { client, socket } = await opened(() => undefined);
    try {
      for (const uid of [0, -1, NaN, Infinity, 1.5]) await expect(client.fetchEnvelopes([uid])).rejects.toThrow('UID');
      await expect(client.select('INBOX\r\nLOGOUT')).rejects.toThrow('control');
      await expect(client.searchUids(NaN)).rejects.toThrow('date');
      expect(await client.fetchEnvelopes([])).toEqual([]);
      expect(socket.writes).toEqual([]);
    } finally { client.close(); }
  });

  test('search keeps valid numeric UIDs and preserves the since-date command', async () => {
    const { client, socket } = await opened((wire, command) => wire.emit('data', `* SEARCH 1 20 0 -3 4x 9007199254740992\r\n${command.split(' ')[0]} OK complete\r\n`));
    try {
      expect(await client.searchUids(Date.UTC(2026, 8, 30))).toEqual([1, 20]);
      expect(socket.writes[0]).toContain('UID SEARCH SINCE 30-Sep-2026');
    } finally { client.close(); }
  });
});

describe('intake IMAP pure response parsing', () => {
  test('unreadable or truncated responses refuse instead of reporting an empty mailbox', () => {
    expect(() => parseFetchResponse('* 1 FETCH (BODY[TEXT] {100}\r\nshort')).toThrow('literal');
    expect(() => parseFetchResponse('* 1 FETCH (FLAGS ())\r\n')).toThrow('Unreadable');
    expect(() => parseFetchResponse('* 1 FETCH (UID 42 BODY[TEXT] "unterminated)')).toThrow('Unreadable');
  });
  test('quoted text cannot forge flags or identity', () => {
    expect(parseFetchResponse('* 1 FETCH (UID 42 BODY[TEXT] "UID 999 FLAGS (\\\\Seen)" FLAGS ())\r\n')[0]).toMatchObject({ uid: 42, seen: false });
  });
  test('case-insensitive protocol atoms leave quoted message text unchanged', () => {
    expect(parseFetchResponse('* 1 fetch (uid 42 body[text] "Mixed CASE text" flags (\\seen))\r\n')[0]).toMatchObject({ uid: 42, seen: true, bodyPreview: 'Mixed CASE text' });
  });
  test('decodes both encoded-word forms and formats UTC protocol dates', () => {
    expect(decodeHeader('=?UTF-8?B?Y2Fmw6k=?=')).toBe('café');
    expect(decodeHeader('=?UTF-8?Q?caf=C3=A9_au_lait?=')).toBe('café au lait');
    expect(decodeHeader('ordinary subject')).toBe('ordinary subject');
    expect(imapDate(Date.UTC(2026, 8, 30))).toBe('30-Sep-2026');
  });
});
