/** Exact intermediate member bytes written by this still-active batch owner. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { contractInputAuthorityMutable, contractInputAuthorityRoot, type ContractInputAuthority } from '../../contract/input-authority.js';
import { assertCapturedPublicationOwner, type CapturedPublicationLease } from './captured-publication.js';

export interface CapturedWriteRevision { readonly kind: 'captured-write-revision' }
interface Revision {
  readonly authority: ContractInputAuthority;
  readonly lease: CapturedPublicationLease;
  readonly path: string;
  readonly fingerprint: string;
}
const revisions = new WeakMap<CapturedWriteRevision, Revision>();
const fingerprint = (stat: ReturnType<typeof statAt>): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
function statAt(path: string) { return lstatSync(path, { bigint: true }); }

export function captureCapturedWriteRevision(
  authority: ContractInputAuthority,
  lease: CapturedPublicationLease,
  source: string,
  expectedBytes: Buffer,
): CapturedWriteRevision {
  assertCapturedPublicationOwner(lease, authority);
  if (!contractInputAuthorityMutable(authority)) throw new Error('immutable input has no owned write revision');
  const root = contractInputAuthorityRoot(authority);
  const path = resolve(source);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('owned write revision is outside its view');
  if (realpathSync(root) !== root || realpathSync(path) !== path) throw new Error('owned write revision contains an alias');
  const stat = statAt(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !expectedBytes.equals(readFileSync(path)) || fingerprint(statAt(path)) !== fingerprint(stat))
    throw new Error('owned write revision differs from published bytes');
  const token = Object.freeze({ kind: 'captured-write-revision' as const });
  revisions.set(token, { authority, lease, path, fingerprint: fingerprint(stat) });
  return token;
}

export function assertCapturedWriteRevision(
  token: CapturedWriteRevision,
  authority: ContractInputAuthority,
  lease: CapturedPublicationLease,
  source: string,
): string {
  assertCapturedPublicationOwner(lease, authority);
  if (!contractInputAuthorityMutable(authority)) throw new Error('immutable input has no owned write revision');
  const state = revisions.get(token);
  if (!state || state.authority !== authority || state.lease !== lease || state.path !== resolve(source))
    throw new Error('backup source has no matching owned write revision');
  if (fingerprint(statAt(state.path)) !== state.fingerprint) throw new Error('owned write revision changed before backup');
  return state.fingerprint;
}
