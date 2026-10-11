import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager, PairingTokenStoreBusyError, type NativeContinuationAuthority } from '../sdk/src/platform/pairing/pairing-token-store.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceBinding = digest('synthetic exact native source and scope');
const successorA = digest('synthetic successor A');
const successorB = digest('synthetic successor B');
const current = () => {};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-continuation-review-')); dirs.push(dir);
  const file = join(dir, 'pairing.json');
  const manager = new PairingTokenManager(file);
  const paired = manager.mint({ name: 'Synthetic review device' });
  const authority: NativeContinuationAuthority = Object.freeze({ ...manager.authenticateNative(paired.token)!, scopes: ['write:synthetic'] });
  const issue = (binding = sourceBinding) => manager.issueNativeContinuation(paired.token, authority, binding, current);
  return { dir, file, manager, paired, authority, issue };
}
function persisted(file: string) { return JSON.parse(readFileSync(file, 'utf8')); }

describe('private pairing native continuation ownership', () => {
  test('an actually issued receipt survives restart without retaining the original credential', () => {
    const item = fixture(); const grant = item.issue();
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(grant)).toEqual(item.authority);
    const disk = readFileSync(item.file, 'utf8');
    expect(disk).not.toContain(item.paired.token);
    expect(JSON.stringify(grant)).not.toContain(item.paired.id);
    expect(JSON.stringify(restarted.readNativeContinuation(grant))).not.toContain('tokenHash');
    expect(restarted.list()[0]).not.toHaveProperty('continuations');
  });

  test('copied watch data and invented IDs cannot create a matching issued record', () => {
    const item = fixture(); const grant = item.issue();
    expect(item.manager.readNativeContinuation({ ...grant, id: 'continuation-11111111-1111-4111-8111-111111111111' })).toBeNull();
    expect(item.manager.readNativeContinuation({ ...grant, binding: digest('other source') })).toBeNull();
    const other = fixture();
    expect(other.manager.readNativeContinuation(grant)).toBeNull();
    expect(() => other.manager.consumeNativeContinuation(grant, successorA, current)).toThrow();
  });

  test('consumption is one immutable successor, including after restart', () => {
    const item = fixture(); const grant = item.issue();
    item.manager.consumeNativeContinuation(grant, successorA, current);
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(grant, successorA)).toEqual(item.authority);
    expect(restarted.readNativeContinuation(grant, successorB)).toBeNull();
    expect(() => restarted.consumeNativeContinuation(grant, successorB, current)).toThrow();
    expect(() => restarted.consumeNativeContinuation(grant, successorA, current)).not.toThrow();
  });

  test('an exact watcher commitment is independently held by the pairing owner across restart', () => {
    const item = fixture(); const grant = item.issue(); const watch = digest('exact synthetic repo, ref, watcher');
    expect(item.manager.readNativeContinuation(grant, undefined, watch)).toBeNull();
    item.manager.bindNativeContinuationWatch(grant, watch, current);
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(grant, undefined, watch)).toEqual(item.authority);
    expect(restarted.readNativeContinuation(grant, undefined, digest('copied watcher for other repo'))).toBeNull();
    expect(() => restarted.bindNativeContinuationWatch(grant, watch, current)).not.toThrow();
    expect(() => restarted.bindNativeContinuationWatch(grant, digest('other watch'), current)).toThrow();
  });

  test('revoked issuance tombstone cannot be reminted from the original token and source binding', () => {
    const item = fixture(); const grant = item.issue(); item.manager.revokeNativeContinuation(grant);
    expect(() => item.issue()).toThrow();
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
  });

  test('revocation is immediate across an already-created owner and restart', () => {
    const item = fixture(); const grant = item.issue();
    const stale = new PairingTokenManager(item.file);
    item.manager.revoke(item.paired.id);
    expect(stale.readNativeContinuation(grant)).toBeNull();
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
    expect(() => stale.consumeNativeContinuation(grant, successorA, current)).toThrow();
  });

  test('re-pairing the same device never transfers its previous grants', () => {
    const item = fixture(); const grant = item.issue();
    const bounded = new PairingTokenManager(item.file, { maxPaired: () => 1 });
    const replacement = bounded.mint({ name: item.paired.name });
    expect(replacement.id).not.toBe(item.paired.id);
    expect(bounded.readNativeContinuation(grant)).toBeNull();
  });

  test('issuing after a reentrant final-source rejection persists no grant', () => {
    const item = fixture(); const before = readFileSync(item.file, 'utf8'); let checks = 0;
    expect(() => item.manager.issueNativeContinuation(item.paired.token, item.authority, sourceBinding, () => {
      if (++checks === 2) throw new Error('synthetic source closed');
    })).toThrow('synthetic source closed');
    expect(readFileSync(item.file, 'utf8')).toBe(before);
  });

  test('owner lock covers async authority use and rejects a concurrent consume/revoke', async () => {
    const item = fixture(); const grant = item.issue(); const other = new PairingTokenManager(item.file);
    let escaped: (() => unknown) | undefined;
    await item.manager.withNativeContinuation(grant, item.authority, async assertCurrent => {
      escaped = assertCurrent; await Promise.resolve();
      expect(() => other.consumeNativeContinuation(grant, successorA, current)).toThrow(PairingTokenStoreBusyError);
      expect(() => other.revokeNativeContinuation(grant)).toThrow(PairingTokenStoreBusyError);
      expect(assertCurrent()).toEqual(item.authority);
    });
    expect(() => escaped!()).toThrow();
    expect(() => other.consumeNativeContinuation(grant, successorA, current)).not.toThrow();
  });

  test('a crash-left writer lock is never stolen by age or construction', async () => {
    const item = fixture(); const grant = item.issue(); mkdirSync(`${item.file}.owner-lock`);
    const restarted = new PairingTokenManager(item.file);
    await expect(restarted.withNativeContinuation(grant, item.authority, current)).rejects.toThrow(PairingTokenStoreBusyError);
    expect(existsSync(`${item.file}.owner-lock`)).toBe(true);
  });

  test('replaced lock cannot be released as though it were still owned', async () => {
    const item = fixture(); const grant = item.issue(); let launched = false;
    await expect(item.manager.withNativeContinuation(grant, item.authority, assertCurrent => {
      renameSync(`${item.file}.owner-lock`, `${item.file}.old-lock`); mkdirSync(`${item.file}.owner-lock`);
      assertCurrent(); launched = true;
    })).rejects.toThrow(PairingTokenStoreBusyError);
    expect(launched).toBe(false); expect(existsSync(`${item.file}.owner-lock`)).toBe(true);
  });

  test('missing/corrupt persisted state refuses without repairing a lookup', () => {
    const item = fixture(); const grant = item.issue();
    for (const value of ['{broken', JSON.stringify({ tokens: [], continuations: [null] })]) {
      writeFileSync(item.file, value); expect(item.manager.readNativeContinuation(grant)).toBeNull();
      expect(readFileSync(item.file, 'utf8')).toBe(value);
    }
    rmSync(item.file); expect(item.manager.readNativeContinuation(grant)).toBeNull(); expect(existsSync(item.file)).toBe(false);
  });

  test('failed persistence returns no successful issuance and latches current owner unavailable', () => {
    const item = fixture(); const before = readFileSync(item.file, 'utf8');
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic failure'); });
    try { expect(() => item.issue()).toThrow('synthetic failure'); } finally { write.mockRestore(); }
    expect(readFileSync(item.file, 'utf8')).toBe(before);
    expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
  });
});

describe('adversarial acceptance requirements', () => {
  test('exact captured authority ID is checked at issuance', () => {
    const item = fixture();
    expect(() => item.manager.issueNativeContinuation(item.paired.token, { ...item.authority, authorityId: 'other-authority' }, sourceBinding, current)).toThrow();
  });

  test('private persisted hash fields cannot be accepted through JSON array coercion', () => {
    for (const field of ['binding', 'tokenRevision', 'ownerRoot', 'watchBinding', 'consumption']) {
      const item = fixture(); const grant = item.issue();
      item.manager.bindNativeContinuationWatch(grant, digest('synthetic watch'), current);
      item.manager.consumeNativeContinuation(grant, successorA, current);
      const snapshot = persisted(item.file); snapshot.continuations[0][field] = [snapshot.continuations[0][field]];
      const raw = JSON.stringify(snapshot); writeFileSync(item.file, raw);
      expect(item.manager.readNativeContinuation(grant)).toBeNull();
      expect(readFileSync(item.file, 'utf8')).toBe(raw);
    }
  });

  test('invalid scope arrays are rejected before they poison the private store', () => {
    const item = fixture(); const before = readFileSync(item.file, 'utf8');
    for (const scopes of [[], [''], ['write:synthetic', 'write:synthetic']]) {
      expect(() => item.manager.issueNativeContinuation(item.paired.token, { ...item.authority, scopes }, sourceBinding, current)).toThrow();
      expect(readFileSync(item.file, 'utf8')).toBe(before);
    }
  });

  test('duplicate issuance cannot create independently consumable successor permissions', () => {
    const item = fixture(); const original = item.issue();
    item.manager.consumeNativeContinuation(original, successorA, current);
    let duplicate: ReturnType<typeof item.issue> | undefined;
    try { duplicate = item.issue(); } catch { /* Refusal is also valid. */ }
    if (duplicate) expect(() => item.manager.consumeNativeContinuation(duplicate!, successorB, current)).toThrow();
  });

  test('changed credential incarnation behind the same public ID cannot retain a grant', () => {
    const item = fixture(); const grant = item.issue(); const snapshot = persisted(item.file);
    snapshot.tokens[0].tokenHash = digest('synthetic replacement credential');
    snapshot.tokens[0].createdAt += 1;
    writeFileSync(item.file, JSON.stringify(snapshot));
    expect(item.manager.readNativeContinuation(grant)).toBeNull();
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
  });

  test('replacement of private owner root cannot transplant an issued grant', () => {
    const item = fixture(); const grant = item.issue(); const saved = readFileSync(item.file, 'utf8');
    renameSync(item.dir, `${item.dir}-old`); dirs.push(`${item.dir}-old`);
    mkdirSync(item.dir); writeFileSync(item.file, saved);
    expect(item.manager.readNativeContinuation(grant)).toBeNull();
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
  });

  test('symlink replacement cannot transplant an issued grant', () => {
    const item = fixture(); const grant = item.issue();
    renameSync(item.file, `${item.file}.relocated`); symlinkSync(`${item.file}.relocated`, item.file);
    expect(item.manager.readNativeContinuation(grant)).toBeNull();
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
  });
});

describe('private consumed-successor lineage', () => {
  function lineage() {
    const item = fixture(); const parent = item.issue();
    item.manager.bindNativeContinuationWatch(parent, digest('synthetic original watch'), current);
    item.manager.consumeNativeContinuation(parent, successorA, current);
    const childBinding = digest('synthetic successor native source');
    const issueChild = () => item.manager.issueNativeContinuationFromGrant(parent, successorA, item.authority, childBinding, current);
    return { ...item, parent, childBinding, issueChild };
  }

  test('an independently persisted consumed successor may transfer its own source without retaining a credential', () => {
    const item = lineage(); const child = item.issueChild();
    const restarted = new PairingTokenManager(item.file);
    expect(child.id).not.toBe(item.parent.id);
    expect(restarted.readNativeContinuation(child)).toEqual(item.authority);
    expect(readFileSync(item.file, 'utf8')).not.toContain(item.paired.token);
    expect(JSON.stringify(child)).not.toContain(item.paired.id);
  });

  test('unconsumed, mismatched, and forged parent references cannot mint children', () => {
    const item = fixture(); const parent = item.issue();
    const childBinding = digest('synthetic new source');
    expect(() => item.manager.issueNativeContinuationFromGrant(parent, successorA, item.authority, childBinding, current)).toThrow();
    item.manager.consumeNativeContinuation(parent, successorA, current);
    expect(() => item.manager.issueNativeContinuationFromGrant(parent, successorB, item.authority, childBinding, current)).toThrow();
    expect(() => item.manager.issueNativeContinuationFromGrant({ ...parent, binding: digest('copied parent') }, successorA, item.authority, childBinding, current)).toThrow();
    expect(() => item.manager.issueNativeContinuationFromGrant(parent, successorA, { ...item.authority, scopes: ['write:unrequested'] }, childBinding, current)).toThrow();
  });

  test('child duplicates retain one successor consumption and cannot be reminted under a different lineage', () => {
    const item = lineage(); const child = item.issueChild();
    expect(item.issueChild()).toEqual(child); item.manager.consumeNativeContinuation(child, successorB, current);
    expect(() => item.manager.consumeNativeContinuation(item.issueChild(), digest('other successor'), current)).toThrow();
    expect(() => item.manager.issueNativeContinuation(item.paired.token, item.authority, item.childBinding, current)).toThrow();
    item.manager.revokeNativeContinuation(child); expect(() => item.issueChild()).toThrow();
  });

  test('ancestor revocation blocks descendant reads, binding, consumption, and further issuance after restart', () => {
    const item = lineage(); const child = item.issueChild();
    item.manager.consumeNativeContinuation(child, successorB, current);
    const grandchild = item.manager.issueNativeContinuationFromGrant(child, successorB, item.authority, digest('synthetic grandchild source'), current);
    item.manager.revokeNativeContinuation(item.parent);
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(child)).toBeNull(); expect(restarted.readNativeContinuation(grandchild)).toBeNull();
    expect(() => restarted.bindNativeContinuationWatch(grandchild, digest('grandchild watch'), current)).toThrow();
    expect(() => restarted.consumeNativeContinuation(grandchild, digest('grandchild successor'), current)).toThrow();
    expect(() => restarted.issueNativeContinuationFromGrant(child, successorB, item.authority, digest('another child source'), current)).toThrow();
  });

  test('a changed ancestor consumption or missing ancestor cannot leave an orphaned descendant live', () => {
    for (const change of ['consumption', 'missing'] as const) {
      const item = lineage(); const child = item.issueChild(); const snapshot = persisted(item.file);
      if (change === 'missing') snapshot.continuations = snapshot.continuations.filter((entry: { id: string }) => entry.id !== item.parent.id);
      else snapshot.continuations.find((entry: { id: string }) => entry.id === item.parent.id).consumption = successorB;
      writeFileSync(item.file, JSON.stringify(snapshot));
      expect(new PairingTokenManager(item.file).readNativeContinuation(child)).toBeNull();
    }
  });

  test('parent binding and consumption must remain literal strings in private records', () => {
    for (const field of ['binding', 'consumption']) {
      const item = lineage(); const child = item.issueChild(); const snapshot = persisted(item.file);
      const row = snapshot.continuations.find((entry: { id: string }) => entry.id === child.id);
      row.parent[field] = [row.parent[field]]; writeFileSync(item.file, JSON.stringify(snapshot));
      expect(new PairingTokenManager(item.file).readNativeContinuation(child)).toBeNull();
    }
  });

  test('cyclic lineage refuses boundedly without following copied parent IDs forever', () => {
    const item = lineage(); const child = item.issueChild(); const snapshot = persisted(item.file);
    const row = snapshot.continuations.find((entry: { id: string }) => entry.id === child.id);
    row.consumption = successorB; row.parent = { ...child, consumption: successorB };
    writeFileSync(item.file, JSON.stringify(snapshot));
    expect(new PairingTokenManager(item.file).readNativeContinuation(child)).toBeNull();
  });

  test('a source lifetime that closes during child issuance publishes no independent grant', () => {
    const item = lineage(); const before = readFileSync(item.file, 'utf8'); let checks = 0;
    expect(() => item.manager.issueNativeContinuationFromGrant(item.parent, successorA, item.authority, item.childBinding,
      () => { if (++checks === 2) throw new Error('synthetic successor owner closed'); })).toThrow('synthetic successor owner closed');
    expect(readFileSync(item.file, 'utf8')).toBe(before);
  });

  test('revoking a child never widens or rewrites its consumed parent identity', () => {
    const item = lineage(); const child = item.issueChild(); item.manager.revokeNativeContinuation(child);
    expect(item.manager.readNativeContinuation(item.parent, successorA)).toEqual(item.authority);
    expect(item.manager.readNativeContinuation(item.parent, successorB)).toBeNull();
    expect(item.manager.readNativeContinuation(child)).toBeNull();
  });
});

describe('private native source cancellation custody', () => {
  test('source cancellation survives missing public rows, refuses remint, and leaves another source live', () => {
    const item = fixture(); const exact = digest('project/root/owner/scope/attempt'); const other = digest('other project/root/owner/scope/attempt');
    const grant = item.manager.issueNativeContinuation(item.paired.token, item.authority, digest('issuance'), current, exact);
    const untouched = item.manager.issueNativeContinuation(item.paired.token, item.authority, digest('other issuance'), current, other);
    item.manager.revokeNativeContinuationsForSource(exact, current);
    const restart = new PairingTokenManager(item.file);
    expect(restart.readNativeContinuation(grant)).toBeNull(); expect(restart.readNativeContinuation(untouched)).toEqual(item.authority);
    expect(() => restart.issueNativeContinuation(item.paired.token, item.authority, digest('new issuance'), current, exact)).toThrow('cancelled');
  });
  test('a consumed successor cancellation retires its parent even before any child issuance', () => {
    const item = fixture(); const original = digest('original source'); const successor = digest('successor source');
    const grant = item.manager.issueNativeContinuation(item.paired.token, item.authority, digest('issue'), current, original);
    item.manager.consumeNativeContinuation(grant, successorA, current, successor);
    expect(() => item.manager.consumeNativeContinuation(grant, successorA, current, digest('different successor'))).toThrow();
    expect(() => item.manager.issueNativeContinuationFromGrant(grant, successorA, item.authority, digest('child'), current, original)).toThrow('differs');
    item.manager.revokeNativeContinuationsForSource(successor, current);
    expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
    expect(() => item.manager.issueNativeContinuationFromGrant(grant, successorA, item.authority, digest('child'), current, successor)).toThrow();
  });
  test('source revocation guard failure and private publication failure never acknowledge success', () => {
    const item = fixture(); const exact = digest('exact source'); const before = readFileSync(item.file, 'utf8');
    expect(() => item.manager.revokeNativeContinuationsForSource(exact, () => { throw new Error('owner changed'); })).toThrow('owner changed');
    expect(readFileSync(item.file, 'utf8')).toBe(before);
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(() => { throw new Error('private publication failed'); });
    try { expect(() => item.manager.revokeNativeContinuationsForSource(exact, current)).toThrow('publication failed'); }
    finally { write.mockRestore(); }
  });
  test('cancellation tombstone exists even when no grant was published yet', () => {
    const item = fixture(); const exact = digest('not yet published source'); item.manager.revokeNativeContinuationsForSource(exact, current);
    expect(() => new PairingTokenManager(item.file).issueNativeContinuation(item.paired.token, item.authority, sourceBinding, current, exact)).toThrow('cancelled');
  });
});
