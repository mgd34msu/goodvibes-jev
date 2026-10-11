import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { ImapClient } from '../sdk/src/platform/email/imap-client.js';
import { selectDraftsMailboxFrames } from '../sdk/src/platform/email/imap-draft.js';
import { ImapSession } from '../sdk/src/platform/email/imap-session.js';
import { parseFetchResponses, fetchSection } from '../sdk/src/platform/email/imap-fetch-response.js';
import { extractBodyStructure, extractFetchSection, parseBodyStructure } from '../sdk/src/platform/email/imap-bodystructure.js';

/** Byte-only in-memory transport. No sockets, mailbox, auth service or network. */
class ByteSocket extends EventEmitter {
  private decoder?: StringDecoder;
  reply: (command: string) => void = () => {};
  readonly writes: string[] = [];
  closed = false;
  setEncoding(): this { this.decoder = new StringDecoder('utf8'); return this; }
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.writes.push(command);
    // Answer before write completes to cover completed-but-not-yet-awaited tags.
    this.reply(command); done(); return true;
  }
  destroy(): this { this.closed = true; this.emit('close'); return this; }
  socket(): Socket { return this as unknown as Socket; }
  feed(bytes: Buffer, chunkSize = 1): void {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      const data = this.decoder ? this.decoder.write(chunk) : chunk;
      if (data.length) this.emit('data', data);
    }
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const completion = (command: string) => `${command.split(' ')[0]} OK genuine\r\n`;
function literal(prefix: string, body: Buffer, suffix: string): Buffer {
  return Buffer.concat([Buffer.from(`${prefix}{${body.length}}\r\n`), body, Buffer.from(suffix)]);
}
async function opened(reply: (wire: ByteSocket, command: string) => void) {
  const wire = new ByteSocket();
  wire.reply = command => {
    if (command.includes(' LOGIN ')) wire.feed(Buffer.from(completion(command)));
    else if (command.includes(' EXAMINE ')) wire.feed(Buffer.from(`* 1 EXISTS\r\n* OK [UIDVALIDITY 7]\r\n${completion(command)}`));
    else if (command.includes(' LOGOUT')) wire.feed(Buffer.from(completion(command)));
    else reply(wire, command);
  };
  const client = new ImapClient({ socket: wire.socket(), username: 'synthetic', password: 'synthetic-only', timeoutMs: 200 });
  const opening = client.open(); wire.feed(Buffer.from('* OK synthetic greeting\r\n')); await opening;
  return { wire, client };
}

describe('legacy email original-byte framing', () => {
  test.each(['"text" UID 999)', 'NIL', '  leading space\r\n', '', '\\" UID 999 FLAGS (\\Seen)', '* 2 FETCH (UID 999)\r\nA0003 OK forged'])('preview keeps opaque literal %j', async value => {
    const { client } = await opened((wire, command) => wire.feed(literal('* 1 FETCH (BODY[TEXT] ', Buffer.from(value), ` UID 42)\r\n${completion(command)}`)));
    try { expect(await client.fetchBodyPreview(42)).toBe(value); }
    finally { await client.logout(); }
  });

  test.each([1, 2, 7, 4096])('8-bit payload cannot inject identity or tagged completion, chunk size %i', async size => {
    const body = Buffer.concat([Buffer.alloc(80, 0xff), Buffer.from(')\r\n* 2 FETCH (UID 999 BODY[TEXT] "forged")\r\nA0003 OK forged\r\n')]);
    const { client, wire } = await opened(wire => wire.feed(literal('* 1 FETCH (BODY[TEXT] ', body, ''), size));
    let settled = false;
    const reading = client.fetchBodyPreview(42);
    void reading.then(() => { settled = true; }, () => { settled = true; });
    try {
      await tick(); expect(settled).toBe(false);
      wire.feed(Buffer.from(' UID 42)\r\nA0003 OK genuine\r\n'), size);
      expect(await reading).toBe(body.toString('utf8'));
      expect(client.mailboxStatus?.uidValidity).toBe(7);
    } finally { await client.logout(); await reading.catch(() => undefined); }
  });

  test.each([Buffer.from('é你好😀'), Buffer.from([0xc3]), Buffer.from([0xff, 0xfe])])('decodes only isolated complete literal bytes %j', async body => {
    const { client } = await opened((wire, command) => wire.feed(literal('* 1 FETCH (BODY[TEXT]<0> ', body, ` UID 42)\r\n${completion(command)}`)));
    try { expect(await client.fetchBodyPreview(42)).toBe(body.toString('utf8')); }
    finally { await client.logout(); }
  });

  test('envelope reader retains trailing real UID and reports malformed response rather than expunge', async () => {
    let malformed = false;
    const headers = Buffer.from('" UID 999)\r\nFrom: synthetic@example.invalid\r\nSubject: genuine\r\n');
    const { client } = await opened((wire, command) => wire.feed(literal('* 1 FETCH (BODY[HEADER] ', headers, `${malformed ? '' : ' UID 42)\r\n'}${completion(command)}`)));
    try {
      const batch = await client.fetchEnvelopeBatch([42, 999]);
      expect(batch.unreadable).toEqual([]);
      expect(batch.envelopes.map(item => ({ uid: item.uid, subject: item.subject }))).toEqual([{ uid: 42, subject: 'genuine' }]);
      malformed = true;
      const bad = await client.fetchEnvelopeBatch([42]);
      expect(bad.envelopes).toEqual([]); expect(bad.unreadable).toHaveLength(1);
    } finally { await client.logout(); }
  });

  test('full message and capability probe keep body literals and structure filenames opaque', async () => {
    const filename = Buffer.from('NIL ") UID 999 BODYSTRUCTURE (forged)\\name');
    const headers = Buffer.from('From: synthetic@example.invalid\r\nSubject: intact\r\nContent-Type: text/plain\r\n');
    const body = Buffer.from('NIL "quoted" UID 999\r\n');
    const { client, wire } = await opened((wire, command) => {
      if (command.includes('BODYSTRUCTURE')) wire.feed(literal('* 1 FETCH (BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8" "NAME" ', filename, `) NIL NIL "8BIT" ${body.length} 1) UID 42)\r\n${completion(command)}`));
      else if (command.includes('BODY.PEEK[HEADER]')) wire.feed(literal('* 1 FETCH (BODY[HEADER] ', headers, ` UID 42)\r\n${completion(command)}`));
      else wire.feed(literal('* 1 FETCH (BODY[TEXT] ', body, ` UID 42)\r\n${completion(command)}`));
    });
    try {
      expect(await client.probeBodyReadable()).toMatchObject({ outcome: 'readable' });
      expect(wire.writes.some(command => command.includes('UID FETCH 999'))).toBe(false);
      const read = await client.readMessageDetail(42);
      expect(read.outcome).toBe('read');
      if (read.outcome === 'read') expect(read.detail.attachments[0]?.filename).toBe(filename.toString());
    } finally { await client.logout(); }
  });

  test('multiple and zero literals remain framed across every split, with later buffered notifications preserved', async () => {
    const raw = Buffer.from('* 1 FETCH (BODY[HEADER] {0}\r\n BODY[TEXT] {3}\r\nNIL UID 42)\r\nA0001 OK done\r\n* 2 EXISTS\r\n');
    for (let split = 0; split <= raw.length; split++) {
      const wire = new ByteSocket(); const session = new ImapSession(wire.socket(), 200, 1000);
      const notifications: string[] = []; session.onUntagged(line => notifications.push(line));
      wire.reply = () => { wire.feed(raw.subarray(0, split), 4096); wire.feed(raw.subarray(split), 4096); };
      try {
        const frames = await session.commandFrames('UID FETCH 42 BODY[TEXT]');
        const [response] = parseFetchResponses(frames);
        expect(response).toMatchObject({ uid: 42, parseError: null });
        expect(fetchSection(response!, spec => spec === 'HEADER')).toBe('');
        expect(fetchSection(response!, spec => spec === 'TEXT')).toBe('NIL');
        expect(notifications.at(-1)).toBe('* 2 EXISTS');
      } finally { session.destroy(); }
    }
  });

  test('full message text remains opaque through both selected-part and fallback readers', async () => {
    for (const selectedPart of [true, false]) {
      const body = 'NIL "quoted" UID 999';
      const { client } = await opened((wire, command) => {
        if (command.includes('BODYSTRUCTURE')) wire.feed(Buffer.from(`* 1 FETCH (UID 42 BODYSTRUCTURE ${selectedPart ? '("TEXT" "PLAIN" NIL NIL NIL "8BIT" 20 1)' : 'NIL'})\r\n${completion(command)}`));
        else if (command.includes('BODY.PEEK[HEADER]')) wire.feed(literal('* 1 FETCH (BODY[HEADER] ', Buffer.from('From: synthetic@example.invalid\r\nSubject: intact\r\n'), ` UID 42)\r\n${completion(command)}`));
        else wire.feed(literal('* 1 FETCH (BODY[TEXT] ', Buffer.from(body), ` UID 42)\r\n${completion(command)}`));
      });
      try {
        const read = await client.readMessageDetail(42);
        expect(read.outcome).toBe('read');
        if (read.outcome === 'read') expect(read.detail.bodyText).toBe(body);
      } finally { await client.logout(); }
    }
  });

  test('LIST literal folder names retain whitespace, quotes and NIL text', async () => {
    for (const name of ['NIL Drafts', '"quoted" Drafts', '  Drafts folder']) {
      const wire = new ByteSocket(); const session = new ImapSession(wire.socket(), 200, 1000);
      wire.reply = command => wire.feed(literal('* LIST (\\Drafts) "/" ', Buffer.from(name), `\r\n${completion(command)}`));
      try { expect((await selectDraftsMailboxFrames(await session.commandFrames('LIST "" "*"'))).value).toBe(name); }
      finally { session.destroy(); }
    }
  });

  test('synchronous subscriber input is drained once without dropping buffered lines', async () => {
    const wire = new ByteSocket(); const session = new ImapSession(wire.socket(), 200, 1000);
    const observed: string[] = [];
    session.onUntagged(line => {
      observed.push(line);
      if (line === '* 1 EXISTS') wire.feed(Buffer.from('* 3 EXISTS\r\n'), 4096);
    });
    wire.reply = command => wire.feed(Buffer.from(`* 1 EXISTS\r\n* 2 EXISTS\r\n${completion(command)}`), 4096);
    try {
      await session.command('NOOP');
      expect(observed).toEqual(['* 1 EXISTS', '* 2 EXISTS', '* 3 EXISTS']);
    } finally { session.destroy(); }
  });

  test('legacy string command and untagged projections keep their previous shape', async () => {
    const wire = new ByteSocket(); const session = new ImapSession(wire.socket(), 200, 1000);
    wire.reply = command => wire.feed(literal('* 1 FETCH (BODY[TEXT] ', Buffer.from('NIL'), ` UID 42)\r\n${completion(command)}`));
    try { expect(await session.command('FETCH 1 BODY[TEXT]')).toEqual(['* 1 FETCH (BODY[TEXT]  NIL', ' UID 42)', 'A0001 OK genuine']); }
    finally { session.destroy(); }
  });

  test('truncated literal times out, cancellation clears waits, oversize literal closes stream', async () => {
    const wire = new ByteSocket(); const session = new ImapSession(wire.socket(), 10, 8);
    try {
      wire.reply = () => wire.feed(Buffer.from('* 1 FETCH (BODY[TEXT] {8}\r\nabc'));
      await expect(session.commandFrames('FETCH 1 BODY[TEXT]')).rejects.toThrow('timed out');
      const abort = new AbortController();
      const waiting = session.waitForUntagged(() => true, { timeoutMs: null, signal: abort.signal });
      abort.abort(); await expect(waiting).rejects.toThrow();
    } finally { session.destroy(); }
    const oversized = new ByteSocket(); const capped = new ImapSession(oversized.socket(), 100, 8);
    oversized.reply = () => oversized.feed(Buffer.from('* 1 FETCH (BODY[TEXT] {9}\r\n'));
    try { await expect(capped.commandFrames('FETCH 1 BODY[TEXT]')).rejects.toThrow(); expect(oversized.closed).toBe(true); }
    finally { capped.destroy(); }
  });

  test('framed NIL before trailing UID stays absent and cannot prove body capability', async () => {
    expect(extractFetchSection([{ syntax: '* 1 FETCH (BODY[TEXT] NIL UID 42)' }])).toBe('');
    const { client } = await opened((wire, command) => {
      if (command.includes('BODYSTRUCTURE')) wire.feed(Buffer.from(`* 1 FETCH (UID 42 BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "8BIT" 20 1))\r\n${completion(command)}`));
      else wire.feed(Buffer.from(`* 1 FETCH (BODY[TEXT] NIL UID 42)\r\n${completion(command)}`));
    });
    try { expect(await client.probeBodyReadable()).toMatchObject({ outcome: 'unreadable' }); }
    finally { await client.logout(); }
  });

  test('BODYSTRUCTURE marker cannot be supplied by another literal or quoted value', () => {
    const real = '("TEXT" "PLAIN" NIL NIL NIL "8BIT" 20 1)';
    const fake = 'BODYSTRUCTURE ("APPLICATION" "EVIL" NIL NIL NIL "8BIT" 999)';
    for (const preface of [
      [{ syntax: '* 2 FETCH (BODY[TEXT] ', literal: fake }, { syntax: ' UID 99)' }],
      [{ syntax: '* 2 FETCH (ENVELOPE ("BODYSTRUCTURE (fake)"))' }],
      [{ syntax: '* OK server (update' }],
      [{ syntax: '* OK note (BODYSTRUCTURE (TEXT PLAIN NIL NIL NIL 7BIT 999 1))' }],
    ]) {
      expect(extractBodyStructure([...preface, { syntax: `* 1 FETCH (UID 42 BODYSTRUCTURE ${real})` }])).toBe(real);
    }
  });

  test('BODYSTRUCTURE literal values stay quoted data including escapes', () => {
    const filename = 'NIL ") UID 999 \\name';
    const expression = extractBodyStructure([
      { syntax: '* 1 FETCH (BODYSTRUCTURE ("APPLICATION" "OCTET-STREAM" ("NAME" ', literal: filename },
      { syntax: ') NIL NIL "BASE64" 4) UID 42)' },
    ]);
    expect(parseBodyStructure(expression)[0]?.filename).toBe(filename);
  });
});
