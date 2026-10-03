/**
 * operator-token-cleanup.ts
 *
 * Shared helper that enumerates the legacy workspace-scoped `operator-tokens.json`
 * locations earlier GoodVibes builds may have written. Used by the in-process
 * bootstrap path so stale-token pruning has a single source of truth for where
 * to look. GoodVibes Agent itself does not own connected-host startup.
 *
 * Adding a new legacy location: append to `workspaceOperatorTokenCandidates` and
 * the new path will be inspected on the next connected-host boot.
 */

import { join } from 'node:path';

/**
 * Return the list of absolute operator-tokens.json paths the TUI may have written
 * at legacy (pre-0.21.28) workspace-scoped locations under `workingDirectory`.
 *
 * The canonical, current-SDK location is `<connectedHostTokenDir>/operator-tokens.json`;
 * this helper is strictly for legacy-cleanup candidates.
 */
export function workspaceOperatorTokenCandidates(workingDirectory: string): readonly string[] {
  return [
    join(workingDirectory, '.goodvibes', 'operator-tokens.json'),
    join(workingDirectory, '.goodvibes', 'tui', 'operator-tokens.json'),
  ];
}
