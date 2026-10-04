import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@/utils/store-file.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  WorkspaceRegistrationStore,
  withWorkspaceRegistrationWriteLockSync,
  type RegisterWorkspaceResult,
  resolveWorkspaceRegistration,
  normalizeWorkspaceRoot,
  probeWorktreeLink,
  type RegisteredWorkspaceRecord,
  type DeclinedWorkspaceRecord,
  type WorkspaceCoverageStatus,
  type WorkspaceGitMetadata,
  type WorkspaceResolution,
} from '@goodvibes-jev/engine/sdk/platform/workspace';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.ts';
import {
  legacyWorkspaceRegisterPath,
  resolveWorkspaceRegisterReadPath,
  sharedWorkspaceRegisterPath,
} from '@goodvibes-jev/engine/sdk/platform/workspace';

export { normalizeWorkspaceRoot } from '@goodvibes-jev/engine/sdk/platform/workspace';
export type {
  DeclinedWorkspaceRecord,
  RegisteredWorkspaceRecord,
  WorkspaceCoverageStatus,
  WorkspaceResolution,
} from '@goodvibes-jev/engine/sdk/platform/workspace';

/**
 * CHECKPOINT-ELIGIBILITY BOUNDARY (owner ruling: the checkpoint boundary stays
 * EXPLICIT, never silently widened).
 *
 * The shared registration store is ONE file the whole platform reads and writes
 * (~/.goodvibes/control-plane/workspace-registrations.json). The TUI's first-open
 * self-recording writes a plain {@link RegisteredWorkspaceRecord} to it for any
 * directory a user merely opens, so "registered in the store" can no longer mean
 * "the owner opted this workspace into automatic checkpoints". The agent's
 * checkpoint boundary must therefore consume ONLY records the owner EXPLICITLY
 * registered for checkpoints, marked by `checkpointEligible === true`.
 *
 * The SDK record schema natively carries both fields (typed on
 * {@link RegisteredWorkspaceRecord}): `origin`, which flow wrote/stamped the
 * record, provenance only, and `checkpointEligible`, where ABSENT MEANS FALSE.
 * The store's `add` stamps/upgrades them typed, and absent options never strip
 * an existing stamp, so one surface's plain self-recording cannot demote
 * another consumer's eligibility.
 */
export const AGENT_EXPLICIT_REGISTRATION_ORIGIN = 'agent-explicit-registration';

/**
 * Shared registered-workspace registry (SDK 1.6.1 platform/workspace/registration),
 * the successor to this fork's local per-user JSON registry
 * (superseded ../config/workspace-registry.ts, deleted).
 *
 * MIGRATION. The local registry's record shape (`{ root, registeredAt, label? }`)
 * is field-identical to the shared store's `RegisteredWorkspaceRecord`, so a local
 * file migrates in as a straight import, see migrateLegacyWorkspaceRegistryIfNeeded.
 *
 * WHY A SYNCHRONOUS RESOLVER EXISTS ALONGSIDE THE ASYNC STORE. The SDK's
 * WorkspaceRegistrationStore is Promise-based (it persists through
 * PersistentStore). createRuntimeServices() (../runtime/services.ts) is
 * synchronous by design, every consumer (the CLI, the TUI bootstrap, every
 * test file) calls it synchronously, and the automatic-checkpoint decision
 * (whether to pass runtimeBus to WorkspaceCheckpointManager) must be made AT
 * construction time, not after an async read resolves later. So this module
 * also ships a synchronous snapshot read + the SDK's PURE resolver
 * (resolveWorkspaceRegistration, no disk/git I/O) for that one call site;
 * every other consumer (the workspaces CLI, a future interactive prompt) goes
 * through the real async store below, the single source of truth for writes.
 * Both read the exact same on-disk file, so there is only ever one registry.
 */

export type StoreShellPaths = Pick<ShellPathService, 'resolveUserPath' | 'homeDirectory'>;

/**
 * Path of the shared store's JSON document, the SAME file the SDK's
 * registerGatewayVerbGroups writes and the daemon reads for checkpoint
 * eligibility.
 *
 * It lives in the platform's shared tier (~/.goodvibes/shared/), which takes no
 * surface root, precisely because three products share it: scoping it per
 * surface would give this agent its own register, and workspaces registered
 * here would vanish from the daemon while the daemon's vanished from here.
 *
 * This is a READ resolver, so it falls back to the pre-split location
 * (~/.goodvibes/control-plane/) while that is still where the state is, the
 * daemon's boot fold moves it, and until then an updated agent must not report
 * the operator's registered workspaces as gone. Writes always go to the shared
 * path; see createWorkspaceRegistrationStore below.
 */
export function sharedWorkspaceRegistrationStorePath(shellPaths: StoreShellPaths): string {
  return resolveWorkspaceRegisterReadPath(shellPaths, existsSync);
}

/** Construct a store instance over the shared file, for callers that can go async (CLI commands, interactive prompts). */
export function createWorkspaceRegistrationStore(shellPaths: StoreShellPaths): WorkspaceRegistrationStore {
  return new WorkspaceRegistrationStore({
    // WRITES go to the shared tier, always; reads fall back to the pre-split
    // location until the daemon's boot fold has moved it.
    path: sharedWorkspaceRegisterPath(shellPaths),
    fallbackReadPath: legacyWorkspaceRegisterPath(shellPaths),
    homeDir: shellPaths.homeDirectory,
    daemonStateDir: shellPaths.resolveUserPath(),
  });
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
 * Synchronous read of the shared store's on-disk JSON, mirroring the store's
 * coverage rows from legacy v1 or native v2. This is not a native authority
 * reader; only WorkspaceRegistrationStore.currentScope can establish that.
 * A missing or unparsable file reads as empty, never throws.
 */
export function readSharedWorkspaceRegistrationSnapshotSync(shellPaths: StoreShellPaths): SharedRegistrationSnapshot {
  const path = sharedWorkspaceRegistrationStorePath(shellPaths);
  if (!existsSync(path)) return { workspaces: [], declines: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.workspaces)) {
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
 * Resolve `path` against the shared registration store SYNCHRONOUSLY: a direct
 * on-disk read plus the SDK's pure resolveWorkspaceRegistration. `git` defaults
 * to a real worktree-link probe (probeWorktreeLink spawns `git`), so a linked
 * orchestration worktree of a registered repo resolves as covered without any
 * extra wiring, the worktree-link inheritance the shared store provides.
 * Callers that already have git metadata (or want to avoid the spawn, e.g. in
 * a pure unit test) can pass it explicitly.
 */
export function resolveWorkspaceRegistrationSync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const snapshot = readSharedWorkspaceRegistrationSnapshotSync(shellPaths);
  const gitMeta = git ?? probeWorktreeLink(path);
  return resolveWorkspaceRegistration({
    path,
    git: gitMeta,
    registrations: snapshot.workspaces,
    declines: snapshot.declines,
  });
}

/**
 * Resolve `path` against ONLY the checkpoint-eligible registrations, the
 * boundary the automatic/explicit checkpoint gate consumes. Identical to
 * {@link resolveWorkspaceRegistrationSync} except the registrations are filtered
 * to `checkpointEligible === true` first, so a plain TUI self-record (registered
 * in the shared store, but never explicitly opted into checkpoints) resolves as
 * NOT covered here even though the general resolver reports it registered.
 * Worktree-link inheritance still applies: a linked worktree of a checkpoint-
 * eligible main repo resolves covered.
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
 * shared registration JSON file (a small synchronous fs read), cheap enough to
 * call on every turn/agent-lifecycle event, unlike calling
 * `resolveCheckpointEligibilitySync` directly (which re-probes git every time).
 *
 * This is what makes registering a workspace mid-launch (an explicit
 * `goodvibes-agent workspaces register` that stamps `checkpointEligible`) take
 * effect on the very next automatic-checkpoint-eligible event in an
 * already-running process, without a restart: a caller that re-runs the returned
 * function on each event always reads current on-disk state. It consumes ONLY
 * checkpoint-eligible records, so a directory a TUI user merely opened never
 * silently becomes checkpoint-eligible to the agent.
 */
export function createWorkspaceRegistrationLiveChecker(
  shellPaths: StoreShellPaths,
  path: string,
): () => WorkspaceCoverageStatus {
  const git = probeWorktreeLink(path);
  return () => resolveCheckpointEligibilitySync(shellPaths, path, git).status;
}

// ---------------------------------------------------------------------------
// One-time migration: local per-user registry -> shared store
// ---------------------------------------------------------------------------

function legacyWorkspaceRegistryPath(shellPaths: StoreShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'checkpoints', 'registered-workspaces.json');
}

function migrationReceiptPath(shellPaths: StoreShellPaths): string {
  // This repo's own receipt, not shared state, it rides the agent's surface
  // root like everything else this product owns.
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'workspace-registration-migration-receipt.json');
}

/**
 * The schema version stamped onto both one-time receipts below, and the
 * completion flag that makes them verifiable.
 *
 * A receipt is the ONLY memory that a one-time migration already ran. Gating on
 * `existsSync` alone accepts a zero-byte or half-written file as proof of
 * completion, which is why these are now parsed instead. See
 * {@link readReceipt} for what each caller does when the parse fails, the two
 * receipts answer that differently, on purpose.
 */
const RECEIPT_SCHEMA_VERSION = 1;

/** A receipt as it is written: the caller's result plus the fields that make it checkable. */
type StampedReceipt<T> = T & { readonly schemaVersion: number; readonly completed: true };

function stampReceipt<T extends object>(result: T): StampedReceipt<T> {
  return { ...result, schemaVersion: RECEIPT_SCHEMA_VERSION, completed: true } as StampedReceipt<T>;
}

/** How a one-time receipt file read. */
type ReceiptState =
  /** No receipt on disk: the migration has not run. */
  | { readonly kind: 'absent' }
  /** A parseable receipt that asserts its own completion. */
  | { readonly kind: 'complete' }
  /** A file is there, but it does not say the migration finished (empty, torn, wrong shape, older schema). */
  | { readonly kind: 'damaged'; readonly reason: string };

/**
 * Read a one-time receipt by PARSING it, never by its mere existence.
 *
 * A file that exists may be zero bytes, truncated, or a page of nothing that a
 * filesystem recovered the inode for but not the data. `existsSync` returns
 * true for every one of those, and the migration it guards is then skipped
 * forever. A receipt must positively assert completion: an object carrying a
 * known schema version and `completed: true`.
 *
 * A receipt written before this check existed carries neither field, so it
 * reads as `damaged` rather than `complete`. That is deliberate and the callers
 * handle it, one re-runs (its work is idempotent), the other does not (its
 * work is not), and both say so out loud.
 */
function readReceipt(path: string): ReceiptState {
  let raw: string;
  try {
    if (!existsSync(path)) return { kind: 'absent' };
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { kind: 'damaged', reason: `unreadable: ${summarizeError(error)}` };
  }
  if (raw.trim().length === 0) return { kind: 'damaged', reason: 'empty file (interrupted write)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', reason: 'not parseable JSON (torn write)' };
  }
  if (!isRecord(parsed)) return { kind: 'damaged', reason: 'not a JSON object' };
  if (parsed.completed !== true) return { kind: 'damaged', reason: 'no completion flag (written before receipts were verifiable)' };
  if (typeof parsed.schemaVersion !== 'number' || !Number.isFinite(parsed.schemaVersion)) {
    return { kind: 'damaged', reason: 'no usable schema version' };
  }
  // A NEWER schema is accepted: a later build already did at least this much,
  // and a downgrade must not re-run a one-time migration on every boot.
  if (parsed.schemaVersion < RECEIPT_SCHEMA_VERSION) {
    return { kind: 'damaged', reason: `older receipt schema (${parsed.schemaVersion} < ${RECEIPT_SCHEMA_VERSION})` };
  }
  return { kind: 'complete' };
}

interface RawSharedStoreDoc {
  readonly version: 1;
  readonly workspaces: unknown[];
  readonly declines: unknown[];
}

/**
 * Raw read of the shared store document that preserves EVERY field on EVERY
 * record verbatim, unlike {@link readSharedWorkspaceRegistrationSnapshotSync},
 * which strips each record to the known shape. Used by the synchronous
 * eligibility backfill below so it never drops another surface's fields (or a
 * future one) when it rewrites the file. A missing/unparsable file reads as an
 * empty document.
 */
function readSharedStoreRawDoc(path: string): RawSharedStoreDoc {
  if (!existsSync(path)) return { version: 1, workspaces: [], declines: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
      return { version: 1, workspaces: [], declines: [] };
    }
    return {
      version: 1,
      workspaces: parsed.workspaces,
      declines: Array.isArray(parsed.declines) ? parsed.declines : [],
    };
  } catch {
    return { version: 1, workspaces: [], declines: [] };
  }
}

/**
 * The agent's EXPLICIT checkpoint-registration path: one typed store `add` that
 * registers `root` (the SDK's own root-guarded write) AND stamps it
 * `checkpointEligible: true` with the agent-explicit origin, the store's `add`
 * carries both fields natively, upgrading an already-present record's stamp in
 * the same call. This is the ONLY way a record becomes checkpoint-eligible at
 * write time, a plain SDK `add` (the TUI's first-open self-recording) never
 * sets the flag, so opening a directory in the TUI cannot widen the agent's
 * checkpoint boundary. Returns the SDK's register result unchanged so callers
 * keep their existing messaging.
 */
export async function registerWorkspaceForCheckpoints(
  shellPaths: StoreShellPaths,
  root: string,
  opts?: { readonly label?: string },
): Promise<RegisterWorkspaceResult> {
  const store = createWorkspaceRegistrationStore(shellPaths);
  return await store.add(root, {
    ...(opts?.label ? { label: opts.label } : {}),
    origin: AGENT_EXPLICIT_REGISTRATION_ORIGIN,
    checkpointEligible: true,
  });
}

function checkpointEligibilityBackfillReceiptPath(shellPaths: StoreShellPaths): string {
  // Also this repo's own receipt; surface-scoped for the same reason.
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'workspace-checkpoint-eligibility-backfill-receipt.json');
}

export interface CheckpointEligibilityBackfillResult {
  readonly sourcePath: string;
  readonly recordsStamped: number;
  readonly backfilledAt: string;
}

/**
 * One-time boot backfill that stamps `checkpointEligible: true` on the shared-
 * store records that came from the agent's OWN explicit registrations, so the
 * new eligibility boundary does not retroactively drop workspaces the owner had
 * already opted into checkpoints before this flag existed. This is exactly the
 * "the consumer that owns checkpointing re-stamps its own roots on boot" the
 * SDK's record schema documents for pre-provenance records; it writes the raw
 * legacy document directly (field-preserving, see readSharedStoreRawDoc) because it
 * runs inside the synchronous createRuntimeServices path where the async typed
 * store cannot be awaited. It takes the same strict writer lock and refuses
 * migrated v2 state; it cannot erase native scope history or mint authority.
 *
 * The honest source of "which records were the agent's explicit list" is the
 * legacy per-user registry file (`<surface>/checkpoints/registered-workspaces.json`)
 *, written only by `workspaces register`, and never deleted by the migration
 * that imported it into the shared store. Every root in it is an explicit owner
 * opt-in, so the matching shared-store record is stamped eligible. This covers
 * both a fresh import (records just migrated in without the flag) and a machine
 * where the import already ran (the earlier commit that migrated the explicit
 * list into the shared store predates this flag).
 *
 * Receipt-gated so it runs once. A missing legacy file writes no receipt
 * (there is no explicit-list source to derive from, and nothing worth
 * remembering); records registered afresh through
 * {@link registerWorkspaceForCheckpoints} are already stamped at write time.
 * Returns null when nothing was backfilled this call.
 *
 * The receipt is validated by PARSING it, not by its existence, and a damaged
 * one RE-RUNS the backfill. That is safe here in a way it is not for the
 * migration below: this pass only ever sets `checkpointEligible: true` on
 * records whose root is in the owner's own explicit legacy list, and it skips
 * any record already carrying the flag. Repeating it stamps the same records
 * with the same value or does nothing at all, it cannot resurrect, duplicate,
 * or un-remove anything. A crash mid-write therefore must not be allowed to
 * strand a user's pre-flag checkpoint opt-ins forever.
 */
export function backfillCheckpointEligibilityIfNeeded(
  shellPaths: StoreShellPaths,
): CheckpointEligibilityBackfillResult | null {
  if (readReceipt(checkpointEligibilityBackfillReceiptPath(shellPaths)).kind === 'complete') return null;
  return legacyWorkspaceWrite(shellPaths, () => backfillCheckpointEligibilityUnlocked(shellPaths));
}

function backfillCheckpointEligibilityUnlocked(shellPaths: StoreShellPaths): CheckpointEligibilityBackfillResult | null {
  const receiptPath = checkpointEligibilityBackfillReceiptPath(shellPaths);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  if (receipt.kind === 'damaged') {
    logger.warn('Checkpoint-eligibility backfill receipt is not usable, re-running the (idempotent) backfill', {
      receiptPath,
      reason: receipt.reason,
    });
  }

  const legacyPath = legacyWorkspaceRegistryPath(shellPaths);
  if (!existsSync(legacyPath)) return null;

  const legacyRoots = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown;
    const list = isRecord(parsed) && Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const root = readString(entry.root);
      if (root) legacyRoots.add(normalizeWorkspaceRoot(root));
    }
  } catch {
    // An unparsable legacy file yields no roots but still writes a receipt below
    // so this is never retried.
  }

  const sharedPath = sharedWorkspaceRegisterPath(shellPaths);
  const doc = readSharedStoreRawDoc(sharedWorkspaceRegistrationStorePath(shellPaths));
  let stamped = 0;
  const workspaces = doc.workspaces.map((entry) => {
    if (!isRecord(entry)) return entry;
    const root = normalizeWorkspaceRoot(readString(entry.root));
    if (!legacyRoots.has(root) || entry.checkpointEligible === true) return entry;
    stamped += 1;
    const existingOrigin = readString(entry.origin);
    return { ...entry, checkpointEligible: true, origin: existingOrigin || AGENT_EXPLICIT_REGISTRATION_ORIGIN };
  });
  if (stamped > 0) writeStoreJson(sharedPath, { version: 1, workspaces, declines: doc.declines });

  const result: CheckpointEligibilityBackfillResult = {
    sourcePath: legacyPath,
    recordsStamped: stamped,
    backfilledAt: new Date().toISOString(),
  };
  writeStoreJson(receiptPath, stampReceipt(result));
  return result;
}

export interface WorkspaceRegistrationMigrationResult {
  readonly sourcePath: string;
  readonly recordsMigrated: number;
  readonly recordsAlreadyPresent: number;
  readonly migratedAt: string;
}

/**
 * Migrate the local per-user registry into the shared store, exactly once.
 *
 * Runs synchronously (see this module's doc comment on why). Idempotent via a
 * receipt file: once written, later calls (any process, any startup) return
 * null immediately without touching either file again, even if the legacy
 * file is still present, and even if an owner later unregisters a migrated
 * root through the new store (a migrated-then-removed root must not come back
 * on the next start). A missing legacy file is not an error and writes no
 * receipt (nothing happened worth remembering); an unparsable legacy file
 * migrates zero records but still writes a receipt so it is never retried.
 *
 * Returns null when nothing was migrated this call (already migrated, or no
 * legacy file); a caller logs only a real migration.
 *
 * THE RECEIPT IS VALIDATED BY PARSING, AND A DAMAGED ONE DOES NOT RE-RUN THIS.
 * That is the opposite of {@link backfillCheckpointEligibilityIfNeeded}, and
 * the difference is not an oversight. This migration is NOT safe to repeat: the
 * legacy file is deliberately never deleted, so a second pass would re-add
 * every legacy root, including ones the owner has since unregistered through
 * the new store. Re-running to recover from a torn receipt would therefore
 * resurrect workspaces the owner explicitly removed, which is a worse outcome
 * than skipping a migration that has, in every realistic case, already run
 * (the receipt is written last, through a pid-unique temp file and an atomic
 * rename, so a torn one means something outside this code damaged it).
 *
 * So a damaged receipt takes the safe branch, treat it as migrated, and says
 * so LOUDLY at warn level with the path and the reason, because the one thing
 * that must not happen is this being decided in silence. An operator who sees
 * that line can delete the receipt to force the migration deliberately.
 */
export function migrateLegacyWorkspaceRegistryIfNeeded(
  shellPaths: StoreShellPaths,
): WorkspaceRegistrationMigrationResult | null {
  // Preserve the existing damaged-receipt disclosure before any registry read.
  // These branches never mutate either the register or its receipt.
  const receiptPath = migrationReceiptPath(shellPaths);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  if (receipt.kind === 'damaged') {
    logger.warn(
      'Workspace-registry migration receipt is not usable, treating the migration as already done, because repeating it '
      + 'would re-add legacy roots the owner may have since unregistered. Delete the receipt to force it.',
      { receiptPath, reason: receipt.reason },
    );
    return null;
  }
  return legacyWorkspaceWrite(shellPaths, () => migrateLegacyWorkspaceRegistryUnlocked(shellPaths));
}

/** Legacy boot writes never race or downgrade a v2 native-authority document. */
function legacyWorkspaceWrite<T>(shellPaths: StoreShellPaths, write: () => T): T | null {
  const path = sharedWorkspaceRegisterPath(shellPaths);
  try {
    return withWorkspaceRegistrationWriteLockSync(path, () => {
      const readPath = existsSync(path) ? path : sharedWorkspaceRegistrationStorePath(shellPaths);
      if (existsSync(readPath)) {
        // A damaged document must not be overwritten by a best-effort legacy
        // migration, either: its native authority history may be unknowable.
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(readPath, 'utf-8')); } catch {
          logger.warn('Legacy workspace migration refuses an unreadable shared registry', { path });
          return null;
        }
        if (!isRecord(parsed) || parsed.version !== 1) {
          logger.warn('Legacy workspace migration refuses a migrated native scope registry', { path });
          return null;
        }
      }
      return write();
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'WORKSPACE_REGISTRY_BUSY') throw error;
    logger.warn('Legacy workspace migration deferred because the shared registry is owned by another operation', { path });
    return null;
  }
}

function migrateLegacyWorkspaceRegistryUnlocked(shellPaths: StoreShellPaths): WorkspaceRegistrationMigrationResult | null {
  const receiptPath = migrationReceiptPath(shellPaths);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  if (receipt.kind === 'damaged') {
    logger.warn(
      'Workspace-registry migration receipt is not usable, treating the migration as already done, because repeating it '
      + 'would re-add legacy roots the owner may have since unregistered. Delete the receipt to force it.',
      { receiptPath, reason: receipt.reason },
    );
    return null;
  }

  const legacyPath = legacyWorkspaceRegistryPath(shellPaths);
  if (!existsSync(legacyPath)) return null;

  let legacyRecords: RegisteredWorkspaceRecord[] = [];
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown;
    const list = isRecord(parsed) && Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    legacyRecords = list
      .map(parseRegisteredRecord)
      .filter((entry): entry is RegisteredWorkspaceRecord => entry !== null);
  } catch {
    legacyRecords = [];
  }

  const sharedPath = sharedWorkspaceRegisterPath(shellPaths);
  const existing = readSharedWorkspaceRegistrationSnapshotSync(shellPaths);
  const existingRoots = new Set(existing.workspaces.map((entry) => entry.root));
  const merged = [...existing.workspaces];
  let migrated = 0;
  let alreadyPresent = 0;
  for (const record of legacyRecords) {
    if (existingRoots.has(record.root)) {
      alreadyPresent += 1;
      continue;
    }
    existingRoots.add(record.root);
    merged.push(record);
    migrated += 1;
  }

  if (migrated > 0) {
    writeStoreJson(sharedPath, { version: 1, workspaces: merged, declines: existing.declines });
  }

  const result: WorkspaceRegistrationMigrationResult = {
    sourcePath: legacyPath,
    recordsMigrated: migrated,
    recordsAlreadyPresent: alreadyPresent,
    migratedAt: new Date().toISOString(),
  };
  writeStoreJson(receiptPath, stampReceipt(result));
  return result;
}

// ---------------------------------------------------------------------------
// First-start registration prompt support
// ---------------------------------------------------------------------------

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Would the shared store refuse to register `root` as too broad? Mirrors the
 * SDK's broadRootReason (checkpoint/root-guard.ts, not part of the public
 * platform/workspace export, so replicated here at the same single-purpose
 * level as this module's other store-internal-logic mirrors) closely enough
 * for a PRE-registration "would this be refused?" check. Used only to decide
 * whether to OFFER registration in the first-start prompt; the store's own
 * add() remains the authoritative guard at write time, never bypassed here.
 */
export function isBroadWorkspaceRoot(shellPaths: StoreShellPaths, root: string): boolean {
  const canonicalRoot = canonicalPath(root);
  if (parse(canonicalRoot).root === canonicalRoot) return true;
  if (canonicalRoot === canonicalPath(shellPaths.homeDirectory)) return true;
  if (canonicalRoot === canonicalPath(shellPaths.resolveUserPath())) return true;
  return false;
}

/**
 * Resolve a first-start registration prompt's answer against the shared
 * store: fire-and-forget (the caller is a keypress handler, not an async
 * context) but never a silent failure, a write error is logged, not lost.
 */
export function answerWorkspaceRegistrationPrompt(shellPaths: StoreShellPaths, root: string, accepted: boolean): void {
  // Accepting the first-start prompt is an EXPLICIT owner opt-in, so it goes
  // through registerWorkspaceForCheckpoints (registers AND stamps eligibility),
  // not a plain store.add, which would register without making the workspace
  // checkpoint-eligible. Declining stays a plain decline.
  const outcome = accepted
    ? registerWorkspaceForCheckpoints(shellPaths, root)
    : createWorkspaceRegistrationStore(shellPaths).decline(root);
  void outcome.catch((error: unknown) => {
    logger.error('Failed to persist workspace registration prompt answer', { root, accepted, error: summarizeError(error) });
  });
}
