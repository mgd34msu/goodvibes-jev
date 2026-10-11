/** Read-only exact revision fence for an already-owned filesystem effect.
 * This closure grants no admission and performs no write or rollback. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function captureFileEffectRevision(source: string, expectedBytes: Buffer): () => void {
  const path = resolve(source);
  const physical = realpathSync(path);
  const parent = realpathSync(dirname(path));
  const stat = () => lstatSync(path, { bigint: true });
  const fingerprint = (value: ReturnType<typeof stat>) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.mode}:${value.nlink}`;
  const before = stat();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !expectedBytes.equals(readFileSync(path)) || fingerprint(stat()) !== fingerprint(before))
    throw new Error('Owned file revision requires the exact expected regular, unaliased bytes');
  const revision = fingerprint(before);
  return () => {
    if (realpathSync(dirname(path)) !== parent || realpathSync(path) !== physical || fingerprint(stat()) !== revision)
      throw new Error('Owned file revision changed; compensation or repair is held');
  };
}
