import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeEmailTransport } from '@goodvibes-jev/engine/sdk/platform/email/node';
import { composeCredentialServices } from '../../runtime/credential-composition.ts';
import { composeMailDeps } from '../../runtime/mail-composition.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeOwnedTempDir('daemon-credential-composition'); roots.push(root);
  const homeDirectory = join(root, 'home'); const workingDirectory = join(root, 'workspace');
  mkdirSync(homeDirectory); mkdirSync(workingDirectory);
  return { root, homeDirectory, workingDirectory, pairingTokenPath: join(root, 'pairings.json'), configManager: undefined };
}

test('the explicit daemon home owns dummy credential storage rather than the ordinary home', async () => {
  const input = fixture(); const daemonHomeDirectory = join(input.root, 'isolated-daemon');
  const services = composeCredentialServices({ ...input, daemonHomeDirectory });
  const key = 'GOODVIBES_DAEMON_DRAFT_AESKEY';
  await services.secretsManager.set(key, 'fixture-only-value', { scope: 'daemon', medium: 'secure' });
  const entry = (await services.secretsManager.listDetailed()).find((value) => value.key === key);
  expect(entry?.path).toBe(join(daemonHomeDirectory, 'secrets.enc'));
  expect(entry?.scope).toBe('daemon');
  expect(existsSync(join(input.homeDirectory, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(false);
  expect(await services.secretsManager.get(key)).toBe('fixture-only-value');
});

test('absence of an override retains the explicitly supplied home and historical surface layout', async () => {
  const input = fixture(); const services = composeCredentialServices(input);
  await services.secretsManager.set('FIXTURE_UNOWNED', 'fixture', { scope: 'user', medium: 'secure' });
  const entry = (await services.secretsManager.listDetailed()).find((value) => value.key === 'FIXTURE_UNOWNED');
  expect(entry?.path).toBe(join(input.homeDirectory, '.goodvibes', 'tui', 'secrets.enc'));
  expect(services.pairingTokens.pairedCount()).toBe(0);
  expect(existsSync(input.pairingTokenPath)).toBe(false);
});

test('pairing metadata is read only from its injected fixture path without minting a token', () => {
  const input = fixture();
  const contents = JSON.stringify({ tokens: [{ id: 'fixture', name: 'Fixture device', tokenHash: 'non-authenticating-fixture-hash', createdAt: 1 }] });
  writeFileSync(input.pairingTokenPath, contents);
  const services = composeCredentialServices(input);
  expect(services.pairingTokens.pairedCount()).toBe(1);
  expect(readFileSync(input.pairingTokenPath, 'utf8')).toBe(contents);
});

test('the step-up verifier reads the same composed secret store and refuses absent enrollment', async () => {
  const services = composeCredentialServices(fixture());
  const read = spyOn(services.secretsManager, 'get').mockResolvedValue(null);
  const assertion = Buffer.from(JSON.stringify({ credentialId: 'fixture', authenticatorData: '', clientDataJSON: '', signature: '' })).toString('base64url');
  try {
    expect(await services.stepUpService.verify(assertion)).toEqual({ ok: false, reason: 'no-credential' });
    expect(read).toHaveBeenCalledWith('relay.stepup.state');
  } finally { read.mockRestore(); }
});

function mail(values: Readonly<Record<string, unknown>>, secret: string | null = null) {
  const reads: string[] = [];
  return { ...composeMailDeps({ configManager: { get: (key) => values[key] }, secretsManager: { async get(key) { reads.push(key); return secret; } } }), reads };
}

test('mail composition maps owner settings while leaving the actual transport uncalled', async () => {
  const result = mail({ 'surfaces.email.host': 'fixture.invalid', 'surfaces.email.user': 'fixture@example.invalid', 'surfaces.email.imap.secure': false, 'surfaces.email.smtp.secure': false }, 'dummy-fixture-password');
  expect(result.emailServiceDeps.transport).toBe(nodeEmailTransport);
  expect(result.emailServiceDeps.getConfig('email.imapHost')).toBe('fixture.invalid');
  expect(result.emailServiceDeps.getConfig('email.username')).toBe('fixture@example.invalid');
  expect(result.emailServiceDeps.getConfig('email.imapSecurity')).toBe('plaintext');
  expect(result.emailServiceDeps.getConfig('email.smtpSecurity')).toBe('starttls');
  expect(await result.describeEmailConfigProblem()).toBeNull();
  expect(result.reads.length).toBeGreaterThan(0);
});

test('mail missing config and missing credentials remain distinct operator-facing refusals', async () => {
  const missing = mail({}); expect(await missing.describeEmailConfigProblem()).toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
  expect(missing.reads).toHaveLength(0);
  const noPassword = mail({ 'surfaces.email.host': 'fixture.invalid', 'surfaces.email.user': 'fixture@example.invalid' });
  expect(await noPassword.describeEmailConfigProblem()).toMatchObject({ code: 'EMAIL_CREDENTIALS_MISSING' });
});

test('sender authentication never becomes command authority at the product boundary', () => {
  const result = mail({});
  expect(result.emailServiceDeps.describeSenderClaim('Fixture <fixture@example.invalid>', { dkim: 'pass', spf: 'pass', dmarc: 'pass' }).commandAuthority).toBe('none');
});
