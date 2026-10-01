import { existsSync, readFileSync } from 'node:fs';
import { resolveWorkspaceRegisterReadPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { ShellPathService } from '../index.js';
import {
  normalizeWorkspaceRoot,
  probeWorktreeLink,
  resolveWorkspaceRegistration,
  type DeclinedWorkspaceRecord,
  type RegisteredWorkspaceRecord,
  type WorkspaceCoverageStatus,
  type WorkspaceGitMetadata,
  type WorkspaceResolution,
} from '@goodvibes-jev/engine/sdk/platform/workspace';

/**
 * Checkpoint eligibility, read live off the shared workspace-registration store.
 *
 * The daemon takes automatic checkpoints on turn and agent-run lifecycle events.
 * Which workspaces that is allowed to happen in is the owner's registered-
 * workspaces-only ruling: only a workspace that was EXPLICITLY registered for
 * checkpoints (`checkpointEligible`) qualifies, and a directory somebody merely
 * opened in a surface never silently becomes checkpoint-eligible.
 *
 * This read is synchronous by design. The decision is made per lifecycle event,
 * inside a subscription callback that cannot await, and it has to reflect the
 * store as it is on disk RIGHT NOW, registering a workspace while the daemon is
 * running has to take effect on the next eligible event, not on the next
 * restart. The SDK's resolver is pure, so the only I/O is one small JSON read
 * plus a single git worktree probe amortized at construction.
 */

export type StoreShellPaths = Pick<ShellPathService, 'resolveUserPath' | 'homeDirectory'>;

/**
 * Path of the shared store's JSON document, the same path the SDK's gateway
 * verb group constructs its own store over.
 *
 * "The same path" is the whole contract, and it is why this goes through the
 * SDK's resolver rather than spelling any location out. goodvibes-agent reads
 * and writes this same file directly and the SDK's gateway writes it, so the
 * register is cross-product state rather than the daemon's own, it lives in
 * the shared tier (~/.goodvibes/shared/), which takes no surface root, so all
 * three resolve one identical path. Until the boot fold has moved it, the
 * resolver falls back to the pre-split location read-only, so this reader never
 * reports an empty register and silently refuses every checkpoint.
 */
export function sharedWorkspaceRegistrationStorePath(shellPaths: StoreShellPaths): string {
  // READ path: the shared tier when it is there, the pre-split location until
  // the daemon's boot fold has moved it. This is a reader, so the fallback is
  // read-only and nothing here ever writes to the legacy address.
  return resolveWorkspaceRegisterReadPath(shellPaths, existsSync);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseRegisteredRecord(value: unknown): RegisteredWorkspaceRecord | null {
  if (!isRecord(value)) return null;
  const root = readString(value.root);
  const registeredAt = readString(value.registeredAt);
  if (!root || !registeredAt || Number.isNaN(Date.parse(registeredAt))) return null;
  const label = readString(value.label);
  const origin = readString(value.origin);
  return {
    root: normalizeWorkspaceRoot(root),
    registeredAt,
    ...(label ? { label } : {}),
    ...(origin ? { origin } : {}),
    // Strictly `true` only; any other value (including absent) is not eligible.
    ...(value.checkpointEligible === true ? { checkpointEligible: true } : {}),
  };
}

function parseDeclinedRecord(value: unknown): DeclinedWorkspaceRecord | null {
  if (!isRecord(value)) return null;
  const root = readString(value.root);
  const declinedAt = readString(value.declinedAt);
  if (!root || !declinedAt || Number.isNaN(Date.parse(declinedAt))) return null;
  return { root: normalizeWorkspaceRoot(root), declinedAt };
}

interface SharedRegistrationSnapshot {
  readonly workspaces: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
}

/**
 * Synchronous read of the shared store's on-disk JSON, mirroring the store's own
 * validation exactly (version 1, workspaces[], declines[]). A missing or
 * unparsable file reads as empty, never throws.
 */
export function readSharedWorkspaceRegistrationSnapshotSync(shellPaths: StoreShellPaths): SharedRegistrationSnapshot {
  const path = sharedWorkspaceRegistrationStorePath(shellPaths);
  if (!existsSync(path)) return { workspaces: [], declines: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
      return { workspaces: [], declines: [] };
    }
    const workspaces = parsed.workspaces
      .map(parseRegisteredRecord)
      .filter((entry): entry is RegisteredWorkspaceRecord => entry !== null);
    const declineList = Array.isArray(parsed.declines) ? parsed.declines : [];
    const declines = declineList
      .map(parseDeclinedRecord)
      .filter((entry): entry is DeclinedWorkspaceRecord => entry !== null);
    return { workspaces, declines };
  } catch {
    return { workspaces: [], declines: [] };
  }
}

/**
 * Resolve `path` against ONLY the checkpoint-eligible registrations, the
 * boundary the automatic and explicit checkpoint gates consume. Worktree-link
 * inheritance still applies: a linked worktree of a checkpoint-eligible main
 * repository resolves as covered.
 */
export function resolveCheckpointEligibilitySync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const snapshot = readSharedWorkspaceRegistrationSnapshotSync(shellPaths);
  const eligible = snapshot.workspaces.filter((entry) => entry.checkpointEligible === true);
  const gitMeta = git ?? probeWorktreeLink(path);
  return resolveWorkspaceRegistration({
    path,
    git: gitMeta,
    registrations: eligible,
    declines: snapshot.declines,
  });
}

/**
 * Build a cheap, repeatable live checkpoint-eligibility checker for one fixed
 * workspace root. `probeWorktreeLink` (a `git` subprocess spawn) runs ONCE here,
 * since a long-running process's working directory and its git-worktree
 * relationship do not change mid-launch; every subsequent call only re-reads the
 * shared registration JSON file, which is cheap enough to call on every
 * turn/agent-lifecycle event.
 */
export function createWorkspaceRegistrationLiveChecker(
  shellPaths: StoreShellPaths,
  path: string,
): () => WorkspaceCoverageStatus {
  const git = probeWorktreeLink(path);
  return () => resolveCheckpointEligibilitySync(shellPaths, path, git).status;
}
