/** Frozen workspace installation can create the bin link before tsc emits it. */
import { chmodSync, type PathLike } from 'node:fs';

export function prepareDaemonCli(path: PathLike = new URL('../dist/cli/entrypoint.js', import.meta.url)): void {
  chmodSync(path, 0o755);
}

if (import.meta.main) prepareDaemonCli();
