import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer } from 'node:tls';
import { EmailService } from '../../sdk/src/platform/email/email-service.ts';
import { nodeEmailTransport } from '../../sdk/src/platform/email/node.ts';
import { testDescribeSenderClaim } from '../_helpers/platform-email-fixtures.ts';

// All endpoints, credentials and certificates are synthetic and owned. This
// guarded subprocess keeps startup CA loading and weakened TLS settings out of
// the shared test process; no production account or provider is involved.
const [mode, key, cert] = process.argv.slice(2);
assert.ok(mode && ['untrusted', 'trusted', 'wrong-host'].includes(mode));
assert.ok(key && cert);
const username = 'synthetic-imap-owner@example.test';
const password = 'synthetic-owned-imap-fixture-secret';
const commands: string[] = [];
const received: string[] = [];
const sockets = new Set<Socket>();
const local = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => {
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.write('* OK [CAPABILITY IMAP4rev1] Owned synthetic mailbox\r\n');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    received.push(chunk);
    buffer += chunk;
    for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      commands.push(line);
      const tag = line.split(' ')[0];
      if (/^\S+ LOGIN /.test(line)) socket.write(`${tag} OK logged in\r\n`);
      else if (/^\S+ EXAMINE /.test(line)) {
        socket.write(`* 0 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 1]\r\n${tag} OK [READ-ONLY] examined\r\n`);
      } else if (/^\S+ UID SEARCH /.test(line)) socket.write(`* SEARCH\r\n${tag} OK searched\r\n`);
      else if (/^\S+ LOGOUT$/.test(line)) socket.end(`* BYE logout\r\n${tag} OK logged out\r\n`);
      else socket.write(`${tag} BAD unexpected synthetic command\r\n`);
    }
  });
});
// Rejected clients are expected, and all sockets must be retired on failures.
local.on('tlsClientError', () => {});
local.on('connection', socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
});
await new Promise<void>((resolve, reject) => {
  local.once('error', reject);
  local.listen(0, 'localhost', resolve);
});
const address = local.address();
assert.ok(address && typeof address !== 'string');
const config: Record<string, unknown> = {
  'email.enabled': true,
  'email.imapHost': 'localhost',
  'email.imapPort': address.port,
  'email.imapSecurity': 'tls',
  'email.smtpHost': 'unused-synthetic.example.test',
  'email.username': username,
  'email.fromAddress': username,
  'email.passwordRef': 'goodvibes://secrets/goodvibes/SYNTHETIC_IMAP_PASSWORD',
};
const service = new EmailService({
  getConfig: key => config[key],
  secretsManager: { async get(key) {
    assert.equal(key, 'SYNTHETIC_IMAP_PASSWORD');
    return password;
  } },
  transport: nodeEmailTransport,
  describeSenderClaim: testDescribeSenderClaim,
});

try {
  if (mode === 'trusted') {
    assert.deepEqual(await service.listInbox(), { messages: [], total: 0 });
    assert.equal(commands.filter(line => /^\S+ LOGIN /.test(line)).length, 1);
    assert.ok(received.join('').includes(password));
    assert.ok(commands.some(line => /^\S+ EXAMINE /.test(line)));
    assert.ok(commands.some(line => /^\S+ UID SEARCH /.test(line)));
  } else {
    await assert.rejects(service.listInbox(), error => {
      assert.ok(error instanceof Error);
      // A timeout, protocol failure or unreachable fixture cannot stand in for
      // the identity check this regression is meant to prove.
      assert.match(error.message, mode === 'wrong-host' ? /hostname|altnames|altname/i : /self.signed|certificate/i);
      return true;
    });
    assert.deepEqual(commands, [], 'no IMAP command before verified server identity');
    assert.equal(received.join(''), '', 'no application bytes or synthetic secret transferred');
  }
  console.log(JSON.stringify({ mode, passed: true,
    loginCount: commands.filter(line => /^\S+ LOGIN /.test(line)).length,
    secretTransferred: received.join('').includes(password),
  }));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => local.close(error => error ? reject(error) : resolve()));
}
