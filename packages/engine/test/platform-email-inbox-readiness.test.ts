import { expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { EmailService, type EmailServiceDeps } from '../sdk/src/platform/email/email-service.js';
import { EmailReplySubjectSourceOwner } from '../sdk/src/platform/email/reply-subject-source.js';
import { createSurfaceEmailConfigReader, createSurfaceEmailInboxConfigReader, withSurfaceEmailConfig } from '../sdk/src/platform/email/surface-config.js';
import { testDescribeSenderClaim, throwingEmailTransport } from './_helpers/platform-email-fixtures.js';
import { SnapshotSocket } from './_helpers/mail-inbox-snapshot.js';

function fixture(surface: boolean, overrides: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = surface ? {
    'surfaces.email.imapHost': 'imap.fixture.invalid', 'surfaces.email.imapUser': 'owner@fixture.invalid',
    'surfaces.email.imapPort': 993, ...overrides,
  } : {
    'email.enabled': true, 'email.imapHost': 'imap.fixture.invalid', 'email.imapPort': 993,
    'email.username': 'owner@fixture.invalid', 'email.passwordRef': 'goodvibes://secrets/goodvibes/SYNTHETIC_PASSWORD',
    ...overrides,
  };
  const owner = new EmailReplySubjectSourceOwner();
  let secrets = 0, connections = 0, smtp = 0;
  const sockets: SnapshotSocket[] = [];
  const deps: EmailServiceDeps = {
    getConfig: key => config[key], replySubjectSourceOwner: owner,
    secretsManager: { get: async () => { secrets++; return 'synthetic'; } },
    transport: throwingEmailTransport, describeSenderClaim: testDescribeSenderClaim,
    imapSocketFactory: async () => {
      connections++; const socket = new SnapshotSocket(); sockets.push(socket);
      setImmediate(() => socket.greet()); return socket as unknown as Socket;
    },
    smtpSocketFactory: async () => { smtp++; throw new Error('SMTP must not run'); },
  };
  return { service: new EmailService(surface ? withSurfaceEmailConfig(deps) : deps), config, deps, owner, sockets,
    secrets: () => secrets, connections: () => connections, smtp: () => smtp };
}

test('canonical IMAP-only surface projection enables owned reads without inventing SMTP settings', async () => {
  const f = fixture(true);
  const ordinary = createSurfaceEmailConfigReader(key => f.config[key]);
  const inbox = createSurfaceEmailInboxConfigReader(key => f.config[key]);
  expect(ordinary('email.enabled')).toBe(false); expect(inbox('email.enabled')).toBe(true);
  expect(inbox('email.smtpHost')).toBe(''); expect(f.service.getStatus().ready).toBe(false);
  const status = f.service.getInboxReadStatus(); expect(status.ready).toBe(true);
  expect(status.config).toMatchObject({ imapHost: 'imap.fixture.invalid', username: 'owner@fixture.invalid', smtpHost: '', passwordRef: '[configured]' });
  const seed = await f.service.readInboxPage(); expect(seed.outcome).toBe('checkpoint-required');
  if (seed.outcome !== 'checkpoint-required') throw new Error('Expected seed plan');
  const page = await f.service.readInboxPage({ checkpoint: seed.next }); expect(page.outcome).toBe('complete');
  expect(f.service.getInboxMailboxObservation(page)).toBeDefined(); expect(f.connections()).toBe(2); expect(f.smtp()).toBe(0);
  const snapshot = await f.service.readInboxBatch(); expect(snapshot.outcome).toBe('complete');
});

test('generic explicitly enabled IMAP-only deps permit owned reads while sends retain all requirements', async () => {
  const f = fixture(false, { 'email.smtpPasswordRef': 'not-a-secret-reference', 'email.fromAddress': '' });
  expect(f.service.getInboxReadStatus().ready).toBe(true); expect(f.service.getStatus().ready).toBe(false);
  expect(f.service.getInboxReadStatus().config.smtpPasswordRef).toBe('[configured]');
  expect(f.service.getStatus().errors).toContain('email.smtpHost is required');
  expect(f.service.getStatus().errors).toContain('email.fromAddress is required');
  expect(f.service.getStatus().errors).toContain('email.smtpPasswordRef must be a goodvibes secret reference (goodvibes://secrets/...)');
  await expect(f.service.sendMail({ to: 'recipient@fixture.invalid', subject: 'Synthetic', body: 'Synthetic', confirm: true })).rejects.toThrow('config is invalid');
  expect(f.smtp()).toBe(0); expect(f.secrets()).toBe(0);
  expect((await f.service.readInboxBatch()).outcome).toBe('complete');
});

test.each(['email.imapHost', 'email.username', 'email.passwordRef'])('missing %s rejects before secrets and transport', async key => {
  const f = fixture(false, { [key]: '' }); expect(f.service.getInboxReadStatus().ready).toBe(false);
  await expect(f.service.readInboxPage()).rejects.toThrow('config is invalid');
  await expect(f.service.readInboxBatch()).rejects.toThrow('config is invalid');
  expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
});

test.each(['surfaces.email.imapHost', 'surfaces.email.imapUser'])('canonical surface missing %s remains disabled for read admission', async key => {
  const f = fixture(true, { [key]: '' }); expect(f.service.getInboxReadStatus().ready).toBe(false);
  await expect(f.service.readInboxPage()).rejects.toThrow('not enabled');
  expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0);
});

test('generic email.enabled=false remains authoritative even with valid IMAP configuration', async () => {
  const f = fixture(false, { 'email.enabled': false, 'email.smtpHost': 'smtp.fixture.invalid', 'email.fromAddress': 'owner@fixture.invalid' });
  expect(f.service.getInboxReadStatus().ready).toBe(false);
  await expect(f.service.readInboxPage()).rejects.toThrow('not enabled');
  await expect(f.service.readInboxBatch()).rejects.toThrow('not enabled');
  await expect(f.service.sendMail({ to: 'recipient@fixture.invalid', subject: 'Synthetic', body: 'Synthetic', confirm: true })).rejects.toThrow('not enabled');
  expect(f.secrets()).toBe(0); expect(f.connections()).toBe(0); expect(f.smtp()).toBe(0);
});

test('raw IMAP credentials are still rejected and ordinary listing retains prior submission validation', async () => {
  const f = fixture(false, { 'email.passwordRef': 'raw-password-marker' });
  expect(f.service.getInboxReadStatus().ready).toBe(false);
  expect(JSON.stringify(f.service.getInboxReadStatus())).not.toContain('raw-password-marker');
  await expect(f.service.readInboxPage()).rejects.toThrow('secret reference');
  expect(f.secrets()).toBe(0);
  const configured = fixture(true);
  await expect(configured.service.listInbox()).rejects.toThrow('not enabled');
  expect(configured.connections()).toBe(0);
});

test('read-only projection preserves canonical nested precedence, mailbox/security and references', () => {
  const config: Record<string, unknown> = { 'surfaces.email.imap.host': 'nested.fixture.invalid', 'surfaces.email.imapHost': 'flat.fixture.invalid',
    'surfaces.email.user': 'primary@fixture.invalid', 'surfaces.email.imapUser': 'fallback@fixture.invalid',
    'surfaces.email.imap.port': 1993, 'surfaces.email.imap.mailbox': 'Owned Folder', 'surfaces.email.imap.secure': false };
  const read = createSurfaceEmailInboxConfigReader(key => config[key]);
  const normal = createSurfaceEmailConfigReader(key => config[key]);
  for (const key of ['email.imapHost', 'email.imapPort', 'email.username', 'email.mailbox', 'email.imapSecurity', 'email.passwordRef', 'email.smtpPasswordRef']) {
    expect(read(key)).toBe(normal(key));
  }
  expect(read('email.imapHost')).toBe('nested.fixture.invalid'); expect(read('email.username')).toBe('primary@fixture.invalid');
  expect(read('email.mailbox')).toBe('Owned Folder'); expect(read('email.imapSecurity')).toBe('plaintext');
  expect(read('email.smtpHost')).toBe('');
});
