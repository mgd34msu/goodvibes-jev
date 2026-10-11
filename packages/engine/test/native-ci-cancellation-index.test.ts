import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.ts';
import { nativeCiDigest, nativeCiSourceBinding } from '../sdk/src/platform/workflow/work-ledger/native-ci-continuation-types.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const guard = () => {};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-cancel-index-')); dirs.push(dir);
  const file = join(dir, 'pairing.json'); const manager = new PairingTokenManager(file);
  const paired = manager.mint({name: 'Synthetic native owner'});
  const authority = {...manager.authenticateNative(paired.token)!, scopes: ['write:work-ledger']};
  const source = nativeCiDigest('source'), successor = nativeCiDigest('successor');
  return {file, manager, paired, authority, source, successor,
    issue(binding = nativeCiDigest('issued'), sourceBinding = source) { return manager.issueNativeContinuation(paired.token, authority, binding, guard, sourceBinding); }};
}
test('private source digest separates project, root, exact key, owner incarnation and workspace incarnation', () => {
  const request = {key: {workId: 'w', criteriaId: 'c', criteriaRevision: '1', attemptId: 'a'}, binding: {authorityId: 'owner', authorityRevision: 'owner-v1', scopeId: 'scope', scopeRevision: 'scope-v1', sourceId: 'source', inputRevision: 'input', actionId: 'action', actionRevision: 'action-v1'}, input: {ask: 'Synthetic source', projectRoot: '/owned/root', sessionId: 'fixture', origin: 'external' as const}};
  const baseline = nativeCiSourceBinding('project', request); const variants = [nativeCiSourceBinding('other-project', request), nativeCiSourceBinding('project', {...request, input: {...request.input, projectRoot: '/other/root'}})];
  for (const key of Object.keys(request.key)) variants.push(nativeCiSourceBinding('project', {...request, key: {...request.key, [key]: 'other'}}));
  for (const key of ['authorityId', 'authorityRevision', 'scopeId', 'scopeRevision']) variants.push(nativeCiSourceBinding('project', {...request, binding: {...request.binding, [key]: 'other'}}));
  expect(variants.every(value => value !== baseline)).toBe(true); expect(new Set(variants).size).toBe(variants.length);
  const f = fixture(); const grants = [baseline, ...variants].map((source, i) => f.issue(nativeCiDigest(`binding-${i}`), source));
  f.manager.revokeNativeContinuationsForSource(baseline, guard);
  expect(f.manager.readNativeContinuation(grants[0]!)).toBeNull();
  for (const grant of grants.slice(1)) expect(f.manager.readNativeContinuation(grant)).toEqual(f.authority);
});
test('cancellation source tombstone defeats restored grant entries and changed issuance binding after restart', () => {
  const f = fixture(); const parent = f.issue();
  f.manager.consumeNativeContinuation(parent, nativeCiDigest('consume'), guard, f.successor);
  const child = f.manager.issueNativeContinuationFromGrant(parent, nativeCiDigest('consume'), f.authority, nativeCiDigest('child'), guard, f.successor);
  const prior = JSON.parse(readFileSync(f.file, 'utf8')).continuations;
  f.manager.revokeNativeContinuationsForSource(f.successor, guard);
  const cancelled = JSON.parse(readFileSync(f.file, 'utf8')); cancelled.continuations = prior; writeFileSync(f.file, JSON.stringify(cancelled));
  const owner = new PairingTokenManager(f.file);
  expect(owner.readNativeContinuation(parent)).toBeNull(); expect(owner.readNativeContinuation(child)).toBeNull();
  expect(() => owner.issueNativeContinuation(f.paired.token, f.authority, nativeCiDigest('fresh-binding'), guard, f.successor)).toThrow('cancelled');
  expect(() => owner.consumeNativeContinuation(parent, nativeCiDigest('consume'), guard, f.successor)).toThrow();
});
test('failed provenance guard writes no cancellation and unissued-source tombstones prevent later issuance', () => {
  const f = fixture(); const grant = f.issue(); const prior = readFileSync(f.file, 'utf8'); let calls = 0;
  expect(() => f.manager.revokeNativeContinuationsForSource(f.source, () => { if (++calls === 2) throw new Error('source no longer current'); })).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe(prior); expect(f.manager.readNativeContinuation(grant)).toEqual(f.authority);
  f.manager.revokeNativeContinuationsForSource(f.successor, guard);
  expect(() => f.issue(nativeCiDigest('late-handoff'), f.successor)).toThrow('cancelled');
  expect(f.manager.readNativeContinuation(grant)).toEqual(f.authority);
});
