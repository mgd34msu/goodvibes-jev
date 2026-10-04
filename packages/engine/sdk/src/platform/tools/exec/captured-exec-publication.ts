import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** Compare and publish a completed projection under the captured mutation lock. */
import type { Stats } from 'node:fs';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { assertContractInputAuthority, authorizeContractInputPath, contractInputAuthorityMutable } from '../../contract/input-authority.js';
import { withCapturedPublication, publishWithinCapturedLease, type CapturedPublicationLease } from '../shared/captured-publication.js';
import type { CapturedExecAuthority } from './captured-exec.js';
export interface CapturedFileBytes { readonly data: Buffer; readonly mode: number }

export async function publishCapturedProjection(
  binding: CapturedExecAuthority,
  originals: ReadonlyMap<string, CapturedFileBytes>,
  originalDirectories: ReadonlyMap<string, number>,
  present: ReadonlySet<string>,
  directories: ReadonlyMap<string, number>,
  changes: ReadonlyMap<string, CapturedFileBytes>,
  signal?: AbortSignal,
  lease?: CapturedPublicationLease,
): Promise<void> {
  const publish = async (assertLeaseCurrent?: () => void): Promise<void> => {
    if (!contractInputAuthorityMutable(binding.authority)) throw new Error('immutable captured input cannot be published');
    const removedFiles = [...originals.keys()].filter((path) => !present.has(path));
    const removedDirectories = [...originalDirectories.keys()].filter((path) => !directories.has(path)).sort((a, b) => b.length - a.length);
    const changedDirectories = [...directories].filter(([path, mode]) => originalDirectories.get(path) !== mode).sort(([a], [b]) => a.length - b.length);
    const writes = new Set([...changes.keys(), ...removedFiles]);
    for (const path of new Set([...writes, ...removedDirectories, ...changedDirectories.map(([path]) => path)]))
      await executePolicyCheck(() => authorizeContractInputPath(binding.authority, join(binding.root, path), binding.readAccessFilter, signal), signal);
    await executePolicyCheck(() => assertContractInputAuthority(binding.authority, binding.root, signal), signal);

    assertLeaseCurrent?.();
    signal?.throwIfAborted();
    // No awaited callbacks between final comparison and publication. The shared
    // lock covers write/edit tools and other completed retained projections.
    if (realpathSync(binding.root) !== binding.root) throw new Error('captured publication root redirected');
    const physical = (path: string): Stats | undefined => {
      let current = binding.root;
      for (const part of path.split(sep)) {
        current = join(current, part);
        try {
          const stat = lstatSync(current);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
            throw new Error('captured publication path is an alias or special file');
          if (current === join(binding.root, path)) return stat;
          if (!stat.isDirectory()) throw new Error('captured publication parent changed');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      }
      return undefined;
    };
    for (const path of writes) {
      const current = physical(path);
      const original = originals.get(path);
      if (original ? !current?.isFile() || !original.data.equals(readFileSync(join(binding.root, path))) || (current.mode & 0o777) !== original.mode : current !== undefined)
        throw new Error('captured output conflicts with a newer member edit');
    }
    for (const [path] of changedDirectories) {
      const current = physical(path);
      const original = originalDirectories.get(path);
      if (original === undefined ? current !== undefined : !current?.isDirectory() || (current.mode & 0o777) !== original)
        throw new Error('captured directory conflicts with a newer member edit');
    }
    const assertCompleteRemoval = (path: string): void => {
      const current = physical(path);
      if (!current?.isDirectory() || !originalDirectories.has(path)) throw new Error('captured directory changed before removal');
      for (const name of readdirSync(join(binding.root, path))) {
        const child = join(path, name);
        const stat = physical(child);
        if (stat?.isDirectory()) assertCompleteRemoval(child);
        else if (!stat?.isFile() || !originals.has(child) || present.has(child))
          throw new Error('captured directory contains unadmitted or newer data');
      }
    };
    for (const path of removedDirectories) assertCompleteRemoval(path);
    for (const [path, mode] of changedDirectories) {
      if (!originalDirectories.has(path)) mkdirSync(join(binding.root, path));
      chmodSync(join(binding.root, path), mode);
    }
    for (const [path, { data, mode }] of changes) {
      writeFileSync(join(binding.root, path), data, { mode });
      chmodSync(join(binding.root, path), mode);
    }
    for (const path of removedFiles) unlinkSync(join(binding.root, path));
    // Never recursively remove a host tree: only now-empty admitted directories.
    for (const path of removedDirectories) rmdirSync(join(binding.root, path));
  };
  if (lease) await publishWithinCapturedLease(lease, binding.authority, publish, signal);
  else await withCapturedPublication(binding.authority, () => publish(), signal);
}
