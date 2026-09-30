import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';

/** Completed proof logs and explicitly retained failed projects are evidence, not abandoned scratch. */
export const PROOF_RETAINED_MARKER = '.keep-proof-output';
/** Longer than the live proof deadlines, so a healthy concurrent proof stays untouched. */
export const STALE_PROOF_TMP_MS = 7 * 24 * 60 * 60 * 1000;

export function retainProofOutput(directory: string): void {
  writeFileSync(join(directory, PROOF_RETAINED_MARKER), 'This proof output was kept intentionally. Remove it when it is no longer needed.\n');
}

function retainManagedAncestor(root: string, workspace: string): void {
  const [ancestor] = relative(root, workspace).split(sep);
  if (ancestor?.startsWith('observe-proof-scratch-')) retainProofOutput(join(root, ancestor));
}

// Observe proofs create plain SQLite scratch. A link, unusual entry, failed
// inspection or oversized tree may be user-selected evidence: leave it alone.
function preserveObserveScratch(directory: string): boolean {
  const pending = [directory];
  let remaining = 1024;
  try {
    while (pending.length > 0) {
      if (--remaining < 0) return true;
      const path = pending.pop()!;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (--remaining < 0 || entry.isSymbolicLink()) return true;
        if (entry.isDirectory()) pending.push(join(path, entry.name));
        else if (!entry.isFile()) return true;
      }
    }
  } catch { return true; }
  return false;
}

/** Select the observe proof's workspace without running any live judgment. */
export function prepareObserveProofWorkspace(explicitWorkspace?: string, root = tmpdir()): string {
  const workspace = explicitWorkspace === undefined ? undefined : resolve(explicitWorkspace);
  if (workspace !== undefined) {
    // Explicitly selected evidence is retained before this or a later run can
    // sweep it, even when it is old or nested under a managed scratch root.
    mkdirSync(workspace, { recursive: true });
    retainProofOutput(workspace);
    const selectedTarget = realpathSync(workspace);
    retainManagedAncestor(resolve(root), workspace);
    let canonicalRoot: string | undefined;
    try { canonicalRoot = realpathSync(root); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (canonicalRoot !== undefined) retainManagedAncestor(canonicalRoot, selectedTarget);
    if (realpathSync(workspace) !== selectedTarget) throw new Error('Explicit proof workspace changed during selection');
  }
  sweepStaleTmpDirs(root, 'observe-proof-scratch-', STALE_PROOF_TMP_MS, { preserveMarker: PROOF_RETAINED_MARKER, preserve: preserveObserveScratch });
  return workspace ?? resolve(mkdtempSync(join(root, 'observe-proof-scratch-')));
}
