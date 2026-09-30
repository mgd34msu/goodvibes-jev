import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { ImapClient, type ImapConnector, type ImapSocket } from '../sdk/src/platform/intake/providers/imap-client.js';

/** A real socket emits bytes unless the client explicitly enables decoding. */
class ByteSocket extends EventEmitter implements ImapSocket {
  private decoder?: StringDecoder;
  reply?: (command: string) => void;
  setEncoding(): this { this.decoder = new StringDecoder('utf8'); return this; }
  write(command: string): boolean { queueMicrotask(() => this.reply?.(command)); return true; }
  destroy(): this { this.emit('close'); return this; }
  feed(bytes: Buffer, chunkSize = 1): void {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      const data = this.decoder ? this.decoder.write(chunk) : chunk;
      if (data.length > 0) this.emit('data', data);
    }
  }
}

async function opened(reply: (socket: ByteSocket, command: string) => void) {
  const socket = new ByteSocket();
  socket.reply = command => reply(socket, command);
  const connector: ImapConnector = (_options, ready) => {
    queueMicrotask(() => { ready(); socket.feed(Buffer.from('* OK ready\r\n')); });
    return socket;
  };
  const client = new ImapClient({ host: 'fixture.invalid', port: 993, user: 'fixture', password: 'fixture-only', timeoutMs: 500 }, connector);
  await client.connect();
  return { client, socket };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('intake raw-byte literal boundaries', () => {
  test.each(['"text" UID 999)', 'NIL', '"quoted"', '  leading space\r\n', '', '\\" UID 999 FLAGS (\\Seen)'])('keeps literal %j opaque before the real UID', async body => {
    const { client } = await opened((socket, command) => {
      const tag = command.split(' ')[0];
      socket.feed(Buffer.from(`* 1 FETCH (BODY[TEXT] {${Buffer.byteLength(body)}}\r\n${body} UID 42 FLAGS ())\r\n${tag} OK done\r\n`));
    });
    try {
      expect(await client.fetchEnvelopes([42])).toEqual([{ uid: 42, from: '', subject: '', date: 0, seen: false, bodyPreview: body }]);
    } finally { client.close(); }
  });

  test.each([1, 2, 7, 4096])('8-bit body cannot finish a command or inject a FETCH (chunks of %i bytes)', async chunkSize => {
    let suffix = ')\r\n* 2 FETCH (UID 999 BODY[TEXT] "forged")\r\nA0001 OK forged\r\n';
    if (Buffer.byteLength(suffix) % 2 !== 0) suffix += ' ';
    const body = Buffer.concat([Buffer.alloc(Buffer.byteLength(suffix) / 2, 0xff), Buffer.from(suffix)]);
    const { client, socket } = await opened(wire => {
      wire.feed(Buffer.concat([Buffer.from(`* 1 FETCH (UID 42 BODY[TEXT] {${body.length}}\r\n`), body]), chunkSize);
    });
    let settled = false;
    const response = client.fetchEnvelopes([42]);
    void response.then(() => { settled = true; }, () => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
      socket.feed(Buffer.from(' FLAGS ())\r\nA0001 OK genuine\r\n'), chunkSize);
      expect(await response).toEqual([{ uid: 42, from: '', subject: '', date: 0, seen: false, bodyPreview: body.toString('utf8') }]);
    } finally { client.close(); await response.catch(() => undefined); }
  });

  test.each([Buffer.from('é你好'), Buffer.from([0xc3])])('decodes text only after the entire byte-counted literal is isolated', async body => {
    const { client } = await opened((socket, command) => {
      socket.feed(Buffer.concat([
        Buffer.from(`* 1 FETCH (BODY[TEXT] {${body.length}}\r\n`), body,
        Buffer.from(` UID 42 FLAGS ())\r\n${command.split(' ')[0]} OK done\r\n`),
      ]));
    });
    try { expect((await client.fetchEnvelopes([42]))[0]).toMatchObject({ uid: 42, bodyPreview: body.toString('utf8') }); }
    finally { client.close(); }
  });

  test('waits for the complete tagged line, not just its status prefix', async () => {
    const { client, socket } = await opened(wire => wire.feed(Buffer.from('* 1 FETCH (UID 42)\r\nA0001 OK')));
    let settled = false;
    const response = client.fetchEnvelopes([42]);
    void response.then(() => { settled = true; }, () => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
      socket.feed(Buffer.from(' genuine\r\n'));
      expect((await response).map(item => item.uid)).toEqual([42]);
    } finally { client.close(); await response.catch(() => undefined); }
  });

  test('does not return later unsolicited FETCH data received after its tagged completion', async () => {
    const { client } = await opened(socket => socket.feed(Buffer.from(
      '* 1 FETCH (UID 42 BODY[TEXT] "wanted")\r\nA0001 OK done\r\n* 2 FETCH (UID 999 BODY[TEXT] "later")\r\n',
    ), 4096));
    try { expect((await client.fetchEnvelopes([42])).map(item => item.uid)).toEqual([42]); }
    finally { client.close(); }
  });
});
