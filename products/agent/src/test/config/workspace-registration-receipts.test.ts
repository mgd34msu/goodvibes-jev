/**
 * workspace-registration-receipts.test.ts, the one-time migration receipts are
 * validated by CONTENT, not by existence.
 *
 * The defect this covers: both `migrateLegacyWorkspaceRegistryIfNeeded` and
 * `backfillCheckpointEligibilityIfNeeded` gated on `existsSync(receiptPath)`.
 * A crash between creating the receipt and finishing the write leaves a
 * zero-byte or torn file that `existsSync` happily accepts, so the migration is
 * skipped forever.
 *
 * The two receipts answer a damaged file DIFFERENTLY, and that difference is
 * the interesting part:
 *   - the BACKFILL re-runs, because stamping `checkpointEligible: true` on
 *     records from the owner's own explicit list is idempotent;
 *   - the MIGRATION does not, because repeating it would re-add legacy roots
 *     the owner may have since unregistered, but it says so loudly instead of
 *     deciding it in silence.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createShellPathService } from '@/runtime/index.ts';
import {
  backfillCheckpointEligibilityIfNeeded,
  createWorkspaceRegistrationStore,
  migrateLegacyWorkspaceRegistryIfNeeded,
  normalizeWorkspaceRoot,
} from '../../config/workspace-registration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

function makeShellPaths() {
  const home = makeProjectTempDir('goodvibes-agent-receipts');
  const work = makeProjectTempDir('goodvibes-agent-receipts-work');
  return { shellPaths: createShellPathService({ workingDirectory: work, homeDirectory: home }), work, home };
}

function legacyRegistryPath(home: string): string {
  return join(home, '.goodvibes', 'agent', 'checkpoints', 'registered-workspaces.json');
}

// Both receipts are this repo's OWN state, not shared platform state, so they
// ride the agent's surface root (~/.goodvibes/agent/control-plane/) rather than
// the pre-split unscoped ~/.goodvibes/control-plane/ the shared register used to
// live in. See migrationReceiptPath / checkpointEligibilityBackfillReceiptPath
// in src/config/workspace-registration.ts.
function migrationReceiptPath(home: string): string {
  return join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-registration-migration-receipt.json');
}

function backfillReceiptPath(home: string): string {
  return join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-checkpoint-eligibility-backfill-receipt.json');
}

/** Seed the legacy per-user registry with one explicitly-registered root. */
function seedLegacyRegistry(home: string, root: string): void {
  mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
  writeFileSync(legacyRegistryPath(home), JSON.stringify({
    version: 1,
    workspaces: [{ root, registeredAt: '2026-01-01T00:00:00.000Z', label: 'legacy' }],
  }));
}

/** Overwrite a receipt with `contents`, standing in for what a crash left behind. */
function damageReceipt(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

/** Capture logger.warn calls made inside `fn`. */
function withCapturedWarns<T>(fn: () => T): { result: T; warns: string[] } {
  const warns: string[] = [];
  const mutable = logger as unknown as { warn(message: string, data?: Record<string, unknown>): void };
  const original = mutable.warn.bind(logger);
  mutable.warn = (message: string) => { warns.push(message); };
  try {
    return { result: fn(), warns };
  } finally {
    mutable.warn = original;
  }
}

/** Every shape a crash can leave that `existsSync` still accepts. */
const DAMAGED_RECEIPTS: ReadonlyArray<readonly [label: string, contents: string]> = [
  ['zero-byte', ''],
  ['whitespace only', '   \n'],
  ['truncated JSON', '{"schemaVersion":1,"comple'],
  ['not an object', '[]'],
  ['a bare literal', 'true'],
  ['no completion flag (the pre-fix receipt shape)', JSON.stringify({ migratedAt: '2026-01-01T00:00:00.000Z', recordsMigrated: 1 })],
  ['completed but no schema version', JSON.stringify({ completed: true })],
  ['an older schema', JSON.stringify({ completed: true, schemaVersion: 0 })],
];

describe('the receipts assert their own completion', () => {
  test('a written migration receipt carries a schema version and a completion flag', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);

    const receipt = JSON.parse(readFileSync(migrationReceiptPath(home), 'utf-8')) as Record<string, unknown>;
    expect(receipt.completed).toBe(true);
    expect(receipt.schemaVersion).toBe(1);
    // The informational payload survives alongside the verification fields.
    expect(receipt.recordsMigrated).toBe(1);
    expect(typeof receipt.migratedAt).toBe('string');
  });

  test('a written backfill receipt carries a schema version and a completion flag', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    backfillCheckpointEligibilityIfNeeded(shellPaths);

    const receipt = JSON.parse(readFileSync(backfillReceiptPath(home), 'utf-8')) as Record<string, unknown>;
    expect(receipt.completed).toBe(true);
    expect(receipt.schemaVersion).toBe(1);
    expect(typeof receipt.recordsStamped).toBe('number');

    // Sanity: the backfill actually did its job before we started tearing files up.
    const snapshot = await createWorkspaceRegistrationStore(shellPaths).snapshot();
    expect(snapshot.workspaces[0]?.checkpointEligible).toBe(true);
  });

  test('no leftover temp receipt is left beside the real one', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(leftoverStoreTempFiles(migrationReceiptPath(home))).toEqual([]);
  });
});

describe('a damaged backfill receipt RE-RUNS the backfill (its work is idempotent)', () => {
  for (const [label, contents] of DAMAGED_RECEIPTS) {
    test(`${label}: the backfill runs again instead of stranding the opt-in`, async () => {
      const { shellPaths, work, home } = makeShellPaths();
      seedLegacyRegistry(home, work);
      migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);

      // The record is in the shared store but not yet stamped, and the receipt
      // a crash left behind claims nothing readable.
      damageReceipt(backfillReceiptPath(home), contents);

      const result = backfillCheckpointEligibilityIfNeeded(shellPaths);
      expect(result).not.toBeNull();

      const snapshot = await createWorkspaceRegistrationStore(shellPaths).snapshot();
      expect(snapshot.workspaces[0]?.root).toBe(normalizeWorkspaceRoot(work));
      expect(snapshot.workspaces[0]?.checkpointEligible).toBe(true);

      // ...and the receipt is now real, so the next boot is a clean no-op.
      expect(backfillCheckpointEligibilityIfNeeded(shellPaths)).toBeNull();
    });
  }

  test('the re-run is disclosed, not silent', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    damageReceipt(backfillReceiptPath(home), '');

    const { warns } = withCapturedWarns(() => backfillCheckpointEligibilityIfNeeded(shellPaths));
    expect(warns.some((m) => m.includes('backfill receipt is not usable'))).toBe(true);
  });

  test('a VALID backfill receipt still short-circuits', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    damageReceipt(backfillReceiptPath(home), JSON.stringify({ completed: true, schemaVersion: 1 }));

    expect(backfillCheckpointEligibilityIfNeeded(shellPaths)).toBeNull();
    const snapshot = await createWorkspaceRegistrationStore(shellPaths).snapshot();
    // Untouched: the receipt said the work was done, and it was believed.
    expect(snapshot.workspaces[0]?.checkpointEligible).toBeUndefined();
  });

  test('a NEWER schema receipt is accepted: a downgrade must not re-backfill every boot', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    damageReceipt(backfillReceiptPath(home), JSON.stringify({ completed: true, schemaVersion: 99 }));

    expect(backfillCheckpointEligibilityIfNeeded(shellPaths)).toBeNull();
  });
});

describe('a damaged migration receipt does NOT re-run (repeating it would resurrect removed roots)', () => {
  test('the migration is treated as done, and the decision is disclosed loudly', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    // The migration ran, then the owner unregistered the root through the new store.
    expect(migrateLegacyWorkspaceRegistryIfNeeded(shellPaths)?.recordsMigrated).toBe(1);
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.remove(work);
    expect((await store.snapshot()).workspaces).toHaveLength(0);

    // ...and then the receipt got damaged.
    damageReceipt(migrationReceiptPath(home), '{"migratedAt":"2026');

    const { result, warns } = withCapturedWarns(() => migrateLegacyWorkspaceRegistryIfNeeded(shellPaths));
    expect(result).toBeNull();
    expect(warns.some((m) => m.includes('migration receipt is not usable'))).toBe(true);

    // The unregistered root did NOT come back, this is the whole reason the
    // damaged branch is conservative here and permissive for the backfill.
    expect((await createWorkspaceRegistrationStore(shellPaths).snapshot()).workspaces).toHaveLength(0);
  });

  for (const [label, contents] of DAMAGED_RECEIPTS) {
    test(`${label}: skipped, and never silently`, () => {
      const { shellPaths, work, home } = makeShellPaths();
      seedLegacyRegistry(home, work);
      damageReceipt(migrationReceiptPath(home), contents);

      const { result, warns } = withCapturedWarns(() => migrateLegacyWorkspaceRegistryIfNeeded(shellPaths));
      expect(result).toBeNull();
      expect(warns.length).toBeGreaterThan(0);
    });
  }

  test('a VALID migration receipt short-circuits with no warning at all', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    damageReceipt(migrationReceiptPath(home), JSON.stringify({ completed: true, schemaVersion: 1 }));

    const { result, warns } = withCapturedWarns(() => migrateLegacyWorkspaceRegistryIfNeeded(shellPaths));
    expect(result).toBeNull();
    expect(warns).toEqual([]);
  });

  test('a NEWER schema receipt is accepted without a warning', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    damageReceipt(migrationReceiptPath(home), JSON.stringify({ completed: true, schemaVersion: 99 }));

    const { result, warns } = withCapturedWarns(() => migrateLegacyWorkspaceRegistryIfNeeded(shellPaths));
    expect(result).toBeNull();
    expect(warns).toEqual([]);
  });

  test('no receipt at all still runs the migration normally', () => {
    const { shellPaths, work, home } = makeShellPaths();
    seedLegacyRegistry(home, work);
    expect(existsSync(migrationReceiptPath(home))).toBe(false);
    expect(migrateLegacyWorkspaceRegistryIfNeeded(shellPaths)?.recordsMigrated).toBe(1);
  });
});
