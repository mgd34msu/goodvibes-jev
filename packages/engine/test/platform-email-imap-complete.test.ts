import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { ImapClient, type ImapCompleteMessageRead } from '../sdk/src/platform/email/imap-client.js';
import { parseBodyStructure, type ImapBodyPart } from '../sdk/src/platform/email/imap-bodystructure.js';
import {
  decodeCompleteTextPart,
  parseCompleteBodyStructure,
} from '../sdk/src/platform/email/imap-bodystructure-complete.js';
import { hasVerifiedImapMessageIdentity } from '../sdk/src/platform/email/imap-message-read.js';

/** In-memory, byte-only transport. Never opens a socket or contacts a provider. */
class SyntheticSocket extends EventEmitter {
  readonly writes: string[] = [];
  closed = false;
  reply: (command: string) => void = () => {};
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    this.writes.push(command); this.reply(command); done(); return true;
  }
  destroy(): this { this.closed = true; this.emit('close'); return this; }
  socket(): Socket { return this as unknown as Socket; }
  feed(bytes: Buffer | string): void { this.emit('data', typeof bytes === 'string' ? Buffer.from(bytes) : bytes); }
}
const done = (command: string) => `${command.split(' ')[0]} OK synthetic\r\n`;
const headers = 'From: sender@example.invalid\r\nSubject: complete\r\nContent-Type: text/plain\r\n\r\n';
const leaf = (body: string, subtype = 'PLAIN', encoding = '8BIT', charset = 'UTF-8') =>
  `("TEXT" "${subtype}" ("CHARSET" "${charset}") NIL NIL "${encoding}" ${Buffer.byteLength(body)} 1)`;
const fullLiteral = (command: string, section: string, body: string | Buffer, uid = 42, suffix = '') => {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  return Buffer.concat([Buffer.from(`* 1 FETCH (BODY[${section}]${suffix} {${bytes.length}}\r\n`), bytes,
    Buffer.from(` UID ${uid})\r\n${done(command)}`)]);
};
interface Fixture {
  readonly body?: string;
  readonly headers?: string;
  readonly structure?: string;
  readonly sections?: Readonly<Record<string, string>>;
  readonly override?: (socket: SyntheticSocket, command: string) => boolean;
}
async function fixture(input: Fixture = {}) {
  const socket = new SyntheticSocket();
  const body = input.body ?? 'A complete body.\r\n';
  socket.reply = command => {
    if (command.includes(' LOGIN ') || command.includes(' LOGOUT')) { socket.feed(done(command)); return; }
    if (command.includes(' EXAMINE ')) { socket.feed(`* 1 EXISTS\r\n* OK [UIDVALIDITY 7]\r\n${done(command)}`); return; }
    if (input.override?.(socket, command)) return;
    if (command.includes('BODY.PEEK[HEADER]')) socket.feed(fullLiteral(command, 'HEADER', input.headers ?? headers));
    else if (command.includes('BODYSTRUCTURE')) socket.feed(`* 1 FETCH (BODYSTRUCTURE ${input.structure ?? leaf(body)} UID 42)\r\n${done(command)}`);
    else {
      const section = /BODY\.PEEK\[([^\]]+)\]/.exec(command)?.[1] ?? '';
      socket.feed(fullLiteral(command, section, input.sections?.[section] ?? body));
    }
  };
  const client = new ImapClient({ socket: socket.socket(), username: 'synthetic-only', password: 'synthetic-only', timeoutMs: 200 });
  const opening = client.open(); socket.feed('* OK synthetic greeting\r\n'); await opening;
  return { client, socket };
}
async function read(input: Fixture = {}): Promise<ImapCompleteMessageRead> {
  const { client } = await fixture(input);
  try { return await client.readCompleteMessageDetail(42); } finally { client.close(); }
}
function expectIncomplete(value: ImapCompleteMessageRead): void {
  expect(value.outcome).toBe('incomplete');
  expect(Object.keys(value).sort()).toEqual(['outcome', 'reason']);
}

describe('strict whole-message source completeness', () => {
  test('complete full raw headers, text and exact UID are frozen, separately from subject provenance', async () => {
    const rawHeaders = `From: sender@example.invalid\r\nSubject: ${'x'.repeat(3_000)}\r\nX-Other: é 😀\r\n\r\n`;
    const result = await read({ headers: rawHeaders, body: 'NIL "quotes" UID 999\r\n* 8 FETCH ()\r\n' });
    expect(result.outcome).toBe('complete');
    if (result.outcome !== 'complete') return;
    expect(result.rawHeaders).toBe(rawHeaders);
    expect(result.rawBodyStructure).toBe(leaf('NIL "quotes" UID 999\r\n* 8 FETCH ()\r\n'));
    expect(result.textSections).toEqual([{ section: '1', contentType: 'text/plain', text: 'NIL "quotes" UID 999\r\n* 8 FETCH ()\r\n' }]);
    expect(result.detail.subject.length).toBeLessThan(3_000); // display behavior is unchanged
    expect(hasVerifiedImapMessageIdentity(result.detail)).toBe(false);
    for (const item of [result, result.detail, result.textSections, result.textSections[0], result.detail.attachments,
      result.detail.deliveryEvidence, result.detail.deliveredTo, result.detail.authenticationResults]) expect(Object.isFrozen(item)).toBe(true);
  });

  test('reads every nested/repeated plain and HTML part, never text/PDF attachment bytes', async () => {
    const a = 'first'; const b = '<b>HTML</b>'; const c = 'later text must also be screened';
    const structure = `((${leaf(a)}${leaf(b, 'HTML')} "ALTERNATIVE")${leaf(c)}`
      + '("TEXT" "PLAIN" NIL NIL NIL "BASE64" 999 1 NIL ("ATTACHMENT" ("FILENAME" "note.txt")))'
      + '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 50000000 NIL ("ATTACHMENT" ("FILENAME" "large.pdf"))) "MIXED")';
    const { client, socket } = await fixture({ structure, sections: { '1.1': a, '1.2': b, '2': c } });
    try {
      const result = await client.readCompleteMessageDetail(42);
      expect(result.outcome).toBe('complete');
      if (result.outcome !== 'complete') return;
      expect(result.textSections.map(part => part.text)).toEqual([a, b, c]);
      expect(result.detail.attachments.map(part => part.filename)).toEqual(['note.txt', 'large.pdf']);
      expect(socket.writes.filter(command => /BODY\.PEEK\[/.test(command)).map(command => /BODY\.PEEK\[([^\]]+)/.exec(command)?.[1]))
        .toEqual(['HEADER', '1.1', '1.2', '2']);
    } finally { client.close(); }
  });

  test('inline nontext MIME cannot masquerade as a complete attachment-only message', async () => {
    for (const structure of ['("APPLICATION" "JSON" NIL NIL NIL "8BIT" 42)',
      '("APPLICATION" "XML" NIL NIL NIL "8BIT" 42 NIL ("INLINE" NIL))']) {
      const { client, socket } = await fixture({ structure });
      try { expectIncomplete(await client.readCompleteMessageDetail(42)); expect(socket.writes.some(line => line.includes('BODY.PEEK[1]'))).toBe(false); }
      finally { client.close(); }
    }
  });

  test('zero-length text is complete only with actual complete empty section', async () => {
    expect((await read({ body: '' })).outcome).toBe('complete');
    expectIncomplete(await read({ body: '', override(socket, command) {
      if (!command.includes('BODY.PEEK[1]')) return false;
      socket.feed(`* 1 FETCH (UID 42 BODY[1] NIL)\r\n${done(command)}`); return true;
    } }));
  });

  test('supports unambiguous quoted body sections and UID-first literal frames', async () => {
    const value = 'short "quoted"';
    const result = await read({ body: value, override(socket, command) {
      if (command.includes('BODY.PEEK[HEADER]')) {
        socket.feed(`* 1 FETCH (UID 42 BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers})\r\n${done(command)}`); return true;
      }
      if (!command.includes('BODY.PEEK[1]')) return false;
      socket.feed(`* 1 FETCH (UID 42 BODY[1] "short \\"quoted\\"")\r\n${done(command)}`); return true;
    } });
    expect(result.outcome).toBe('complete');
  });

  test.each(['wrong-uid', 'wrong-section', 'partial', 'duplicate-uid', 'duplicate-section', 'extra-response', 'trailing-syntax', 'nil', 'malformed-quote'])
  ('rejects %s header evidence before any body fetch', async kind => {
    const { client, socket } = await fixture({ override(wire, command) {
      if (!command.includes('BODY.PEEK[HEADER]')) return false;
      if (kind === 'wrong-uid') wire.feed(fullLiteral(command, 'HEADER', headers, 43));
      else if (kind === 'wrong-section') wire.feed(fullLiteral(command, 'TEXT', headers));
      else if (kind === 'partial') wire.feed(fullLiteral(command, 'HEADER', headers, 42, '<0>'));
      else if (kind === 'nil') wire.feed(`* 1 FETCH (UID 42 BODY[HEADER] NIL)\r\n${done(command)}`);
      else if (kind === 'malformed-quote') wire.feed(`* 1 FETCH (UID 42 BODY[HEADER] "unterminated)\r\n${done(command)}`);
      else {
        const suffix = kind === 'duplicate-uid' ? ' UID 42 UID 42)'
          : kind === 'duplicate-section' ? ' UID 42 BODY[HEADER] "")'
            : kind === 'extra-response' ? ' UID 42)\r\n* 2 FETCH (UID 43 BODY[HEADER] "")'
              : ' UID 42) ignored';
        wire.feed(`* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers}${suffix}\r\n${done(command)}`);
      }
      return true;
    } });
    try { expectIncomplete(await client.readCompleteMessageDetail(42)); expect(socket.writes.some(line => line.includes('BODYSTRUCTURE'))).toBe(false); }
    finally { client.close(); }
  });

  test.each(['Subject: missing terminator\r\n', ' orphan continuation\r\n\r\n', 'Subject: before\r\n\r\nSubject: hidden\r\n\r\n', 'broken header\r\n\r\n', 'Subject: \ufffd\r\n\r\n'])
  ('refuses malformed/truncated headers %j', async rawHeaders => { expectIncomplete(await read({ headers: rawHeaders })); });

  test.each(['wrong-uid', 'partial', 'wrong-section', 'missing', 'short', 'long', 'failed'])
  ('refuses %s text fetch without exposing acquired headers or body', async kind => {
    expectIncomplete(await read({ body: 'five!', override(socket, command) {
      if (!command.includes('BODY.PEEK[1]')) return false;
      if (kind === 'failed') socket.feed(`${command.split(' ')[0]} NO secret provider explanation\r\n`);
      else if (kind === 'missing') socket.feed(done(command));
      else socket.feed(fullLiteral(command, kind === 'wrong-section' ? '2' : '1',
        kind === 'short' ? 'five' : kind === 'long' ? 'five!!' : 'five!', kind === 'wrong-uid' ? 43 : 42, kind === 'partial' ? '<0>' : ''));
      return true;
    } }));
  });

  test('invalid original UTF-8 is refused even when replacement output has the declared byte length', async () => {
    expectIncomplete(await read({ body: 'abc', override(socket, command) {
      if (!command.includes('BODY.PEEK[1]')) return false;
      socket.feed(fullLiteral(command, '1', Buffer.from([0xed, 0xa0, 0x80]))); return true;
    } }));
  });

  test('wrong-UID BODYSTRUCTURE is refused before any text fetch', async () => {
    const { client, socket } = await fixture({ override(wire, command) {
      if (!command.includes('BODYSTRUCTURE')) return false;
      wire.feed(`* 1 FETCH (UID 43 BODYSTRUCTURE ${leaf('other')})\r\n${done(command)}`); return true;
    } });
    try { expectIncomplete(await client.readCompleteMessageDetail(42)); expect(socket.writes.some(line => line.includes('BODY.PEEK[1]'))).toBe(false); }
    finally { client.close(); }
  });

  test('oversized declarations and unsupported text are refused before text fetch', async () => {
    for (const structure of [leaf('a', 'CALENDAR'), leaf('a').replace(' 1 1)', ' 1048577 1)')]) {
      const { client, socket } = await fixture({ structure });
      try { expectIncomplete(await client.readCompleteMessageDetail(42)); expect(socket.writes.some(line => line.includes('BODY.PEEK[1]'))).toBe(false); }
      finally { client.close(); }
    }
  });

  test('combined decoded text exceeding source budget is refused without clipping', async () => {
    const body = Buffer.alloc(530_000, 0xe9).toString('base64');
    expect(await read({ body, structure: leaf(body, 'PLAIN', 'BASE64', 'ISO-8859-1') }))
      .toEqual({ outcome: 'incomplete', reason: 'complete-source-too-large' });
  });

  test('a later failed text section refuses the whole message', async () => {
    expectIncomplete(await read({ structure: `(${leaf('first')}${leaf('second')} "MIXED")`, sections: { '1': 'first' }, override(socket, command) {
      if (!command.includes('BODY.PEEK[2]')) return false;
      socket.feed(`${command.split(' ')[0]} NO unavailable\r\n`); return true;
    } }));
  });

  test('gone requires an actual empty successful header-fetch response', async () => {
    const result = await read({ override(socket, command) { socket.feed(done(command)); return true; } });
    expect(result).toEqual({ outcome: 'gone' });
    expectIncomplete(await read({ override(socket, command) { socket.feed(`* 1 FETCH malformed\r\n${done(command)}`); return true; } }));
  });

  test('an invalid UID is refused without issuing a command', async () => {
    const { client, socket } = await fixture();
    try {
      const initial = socket.writes.length;
      for (const uid of [0, -1, 0.5, Number.NaN, 4_294_967_296]) expectIncomplete(await client.readCompleteMessageDetail(uid));
      expect(socket.writes.length).toBe(initial);
    } finally { client.close(); }
  });

  test('strict byte limit closes an unframed growing response and settles the real command', async () => {
    const { client, socket } = await fixture({ override(wire, command) {
      if (!command.includes('BODY.PEEK[HEADER]')) return false;
      wire.feed('x'.repeat(70_000)); return true;
    } });
    expectIncomplete(await client.readCompleteMessageDetail(42));
    expect(socket.closed).toBe(true);
    client.close();
  });

  test('strict aggregate byte limit bounds many individually small unsolicited frames', async () => {
    const { client, socket } = await fixture({ override(wire, command) {
      if (!command.includes('BODY.PEEK[HEADER]')) return false;
      for (let index = 0; index < 100 && !wire.closed; index++) wire.feed(`* OK ${'x'.repeat(1000)}\r\n`);
      return true;
    } });
    expectIncomplete(await client.readCompleteMessageDetail(42)); expect(socket.closed).toBe(true); client.close();
  });

  test('close settles a pending complete read immediately without issuing LOGOUT', async () => {
    const { client, socket } = await fixture({ override(_socket, command) { return command.includes('BODY.PEEK[1]'); } });
    const pending = client.readCompleteMessageDetail(42);
    await new Promise<void>(resolve => setImmediate(resolve));
    client.close(); expectIncomplete(await pending); expect(socket.closed).toBe(true);
    expect(socket.writes.some(command => command.includes('LOGOUT'))).toBe(false);
  });
});

describe('strict canonical MIME tree and decoding', () => {
  const malformed = [
    leaf('a').slice(0, -1), leaf('a') + ' extra', leaf('a').replace('1 1)', '1junk 1)'),
    leaf('a').replace('"TEXT" "PLAIN"', '"TEXT""PLAIN"'),
    leaf('a').replace('"UTF-8"', '"UTF-8'),
    leaf('a').replace('"UTF-8"', '"UTF-8" "CHARSET" "UTF-8"'),
    leaf('a').replace('1 1)', '"1" 1)'), leaf('a').replace('1 1)', '-1 1)'),
    leaf('a', 'CALENDAR'), leaf('a').replace('"UTF-8"', '"UTF-8" "FILENAME*" "secret.txt"'),
    `(${leaf('a')} "ENCRYPTED")`, `(${leaf('a')} "MIXED" NIL ("ATTACHMENT" NIL))`,
    leaf('a').replace(' 1 1)', ' 1048577 1)'),
    `(${'('.repeat(30)}${leaf('a')}${')'.repeat(30)} "MIXED")`,
    `(${'("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0)'.repeat(201)} "MIXED")`,
    '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0 NIL NIL NIL NIL "unknown-extension")',
    '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0 NIL NIL ("attachment"))',
    '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 42 NIL NIL 1)',
    '("APPLICATION" "JSON" NIL NIL NIL "8BIT" 42)',
    '("APPLICATION" "XML" NIL NIL NIL "8BIT" 42 NIL ("INLINE" NIL))',
    '("IMAGE" "PNG" NIL NIL NIL "BASE64" 42)',
    '("TEXT" "PLAIN" ("NAME" {3}\r\nabc) NIL NIL "7BIT" 0 0)',
    `("TEXT" "PLAIN" ("NAME" "${'x'.repeat(200_000)}") NIL NIL "7BIT" 0 0)`,
  ];
  test.each(malformed)('does not turn a malformed/unsupported tree into completeness (#%#)', raw => {
    expect(parseCompleteBodyStructure(raw)).toBeNull();
  });
  test('strict refusals do not change the lenient collector', () => {
    expect(parseBodyStructure(leaf('body').slice(0, -1))).toHaveLength(1);
    expect(parseBodyStructure(`(${'("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0)'.repeat(201)} "MIXED")`)).toHaveLength(200);
  });
  function part(raw: string, encoding: string, charset = 'utf-8'): ImapBodyPart {
    return { section: '1', type: 'text', subtype: 'plain', encoding, charset, filename: '', sizeBytes: Buffer.byteLength(raw), isAttachment: false };
  }
  test.each([
    ['SGVsbG8=', 'base64', 'utf-8', 'Hello'], ['Y2Fmw6k=', 'base64', 'utf-8', 'café'],
    ['Y2Fm6Q==', 'base64', 'iso-8859-1', 'café'], ['gA==', 'base64', 'windows-1252', '€'],
    ['caf=C3=A9=\r\n!', 'quoted-printable', 'utf-8', 'café!'], ['caf=E9', 'quoted-printable', 'latin1', 'café'],
    ['plain\r\n', '7bit', '', 'plain\r\n'], ['é 😀', '8bit', 'utf-8', 'é 😀'],
    ['77u/SGk=', 'base64', 'utf-8', '\ufeffHi'],
  ])('exact supported decoding %j (%s, %s)', (raw, encoding, charset, expected) => {
    expect(decodeCompleteTextPart(raw!, part(raw!, encoding!, charset!))).toBe(expected);
  });
  test.each([
    ['SGVsbG8=!', 'base64', 'utf-8'], ['Zh==', 'base64', 'utf-8'], ['Zg', 'base64', 'utf-8'],
    ['=XX', 'quoted-printable', 'utf-8'], ['trailing=', 'quoted-printable', 'utf-8'], ['a=\nb', 'quoted-printable', 'utf-8'],
    ['xx', 'x-unknown', 'utf-8'], ['YWJj', 'base64', 'x-unknown'], ['/w==', 'base64', 'utf-8'],
    ['wA==', 'base64', 'us-ascii'], ['é', '7bit', 'utf-8'], ['é', '8bit', 'iso-8859-1'],
    ['\ufffd', '8bit', 'utf-8'], ['AA==', 'base64', 'utf-8'],
  ])('refuses substitutions/unknown decoding %j (%s, %s)', (raw, encoding, charset) => {
    expect(decodeCompleteTextPart(raw!, part(raw!, encoding!, charset!))).toBeNull();
  });
});


describe('strict bounded UID search', () => {
  test.each([false, true])('sorts exact distinct UIDs with unreadOnly=%s', async unreadOnly => {
    const { client, socket } = await fixture({ override(wire, command) {
      wire.feed(`* SEARCH 9 1 4294967295 2\r\n${done(command)}`); return true;
    } });
    try {
      const uids = await client.searchCompleteUids(unreadOnly);
      expect(uids).toEqual([1, 2, 9, 4_294_967_295]); expect(Object.isFrozen(uids)).toBe(true);
      expect(socket.writes.at(-1)).toContain(`UID SEARCH ${unreadOnly ? 'UNSEEN' : 'ALL'}\r\n`);
    } finally { client.close(); }
  });
  test('a present empty SEARCH is a complete empty mailbox', async () => {
    const { client } = await fixture({ override(wire, command) { wire.feed(`* SEARCH\r\n${done(command)}`); return true; } });
    try { expect(await client.searchCompleteUids(false)).toEqual([]); } finally { client.close(); }
  });
  test.each(['', '* SEARCH 1 1\r\n', '* SEARCH 1junk\r\n', '* SEARCH 0\r\n', '* SEARCH 4294967296\r\n',
    '* SEARCH -1\r\n', '* SEARCH 01\r\n', '* SEARCH 1.5\r\n', '* SEARCH 1\r\n* SEARCH 2\r\n', '* SEARCH 1\r\n* SEARCH\r\n'])
  ('refuses malformed/ambiguous search %j', async response => {
    const { client } = await fixture({ override(wire, command) { wire.feed(`${response}${done(command)}`); return true; } });
    try { await expect(client.searchCompleteUids(false)).rejects.toThrow('UID SEARCH response was incomplete'); } finally { client.close(); }
  });
});
