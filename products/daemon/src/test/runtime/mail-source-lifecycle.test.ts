import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { readEmailConfig } from '@goodvibes-jev/engine/sdk/platform/email';
import { composeMailDeps } from '../../runtime/mail-composition.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeOwnedTempDir('mail-source-lifecycle'); roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  configManager.set('surfaces.email.host', 'fixture.invalid');
  configManager.set('surfaces.email.user', 'fixture@example.invalid');
  const changes = new Set<(key: string) => void>();
  let reads = 0;
  let dispose = () => {};
  const { emailServiceDeps } = composeMailDeps({
    configManager,
    secretsManager: {
      get: async () => { reads += 1; return 'synthetic'; },
      onDidChange(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
    },
    registerDispose: (callback) => { dispose = callback; },
  });
  const owner = emailServiceDeps.replySubjectSourceOwner!;
  const begin = () => owner.beginRead(readEmailConfig(emailServiceDeps.getConfig), 42);
  const source = () => {
    const read = begin(); read.observeMailbox('INBOX', 7);
    return read.complete(42, 'INBOX', 'Synthetic subject')!;
  };
  return { configManager, emailServiceDeps, begin, source, dispose: () => dispose(), reads: () => reads, changes };
}

test('real config subscription revokes ABA, category merge/removal, reset and reload sources', () => {
  const state = fixture();
  const first = state.source();
  const pending = state.begin();
  state.configManager.set('surfaces.email.user', 'other@example.invalid');
  state.configManager.set('surfaces.email.user', 'fixture@example.invalid');
  pending.observeMailbox('INBOX', 7);
  expect(pending.complete(42, 'INBOX', 'Old account')).toBeUndefined();
  expect(first.signal.aborted).toBe(true);
  for (const change of [
    () => state.configManager.mergeCategory('helper', { syntheticEpoch: 'value' } as never),
    () => state.configManager.removeCategoryKey('helper', 'syntheticEpoch'),
    () => state.configManager.reset('provider.model'),
    () => state.configManager.load(),
  ]) {
    const source = state.source(); change(); expect(source.signal.aborted).toBe(true);
  }
  expect(state.reads()).toBe(0);
  state.dispose();
});

test('shared, IMAP fallback and aliased credential changes revoke without resolving credentials; shutdown unsubscribes', () => {
  const state = fixture();
  for (const key of ['GOODVIBES_SURFACES_EMAIL_PASSWORD', 'GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD', 'SYNTHETIC_ALIAS_TARGET', 'UNRELATED_SYNTHETIC_KEY']) {
    const source = state.source();
    const pending = state.begin();
    for (const listener of state.changes) listener(key);
    pending.observeMailbox('INBOX', 7);
    expect(pending.complete(42, 'INBOX', 'Stale credential')).toBeUndefined();
    expect(source.signal.aborted).toBe(true);
  }
  const source = state.source();
  state.dispose();
  expect(source.signal.aborted).toBe(true);
  expect(state.changes.size).toBe(0);
  expect(state.source()).toBeUndefined();
  expect(state.reads()).toBe(0);
});

test('narrow composition lacks provenance unless all lifecycle hooks and disposal are owned', () => {
  const { emailServiceDeps } = composeMailDeps({ configManager: { get: () => undefined }, secretsManager: { get: async () => null } });
  expect(emailServiceDeps.replySubjectSourceOwner).toBeUndefined();
});

test('canonical mail composition revokes mailbox observations with subject sources on reload, secret changes and shutdown', () => {
  const state = fixture();
  const observe = () => {
    const read = state.begin(); read.observeMailbox('INBOX', 7);
    return { source: read.complete(42, 'INBOX', 'Synthetic subject')!, mailbox: read.completeMailboxObservation()! };
  };
  for (const mutate of [
    () => { state.configManager.set('surfaces.email.user', 'other@example.invalid'); state.configManager.set('surfaces.email.user', 'fixture@example.invalid'); },
    () => state.configManager.load(),
    () => { for (const listener of state.changes) listener('SYNTHETIC_ALIAS_TARGET'); },
    () => state.dispose(),
  ]) {
    const { source, mailbox } = observe();
    expect(mailbox.uidValidity).toBe(7); mutate();
    expect(source.signal.aborted).toBe(true); expect(mailbox.signal.aborted).toBe(true);
    expect(() => mailbox.assertCurrent()).toThrow();
  }
  expect(state.changes.size).toBe(0); expect(state.reads()).toBe(0);
});
