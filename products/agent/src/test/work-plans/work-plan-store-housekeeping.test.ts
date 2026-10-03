/**
 * Recovery and bounding for the Agent's work plan.
 *
 * The store is the SDK's (@goodvibes-jev/engine/sdk/platform/workflow), constructed
 * with this product's surface root so the plan file lands at
 * <home>/.goodvibes/agent/work-plans/<projectId>.json. What is pinned here is
 * what the Agent depends on: /work-plan stays usable when the file on disk is
 * torn, a user's open work is never garbage-collected, and anything reclaimed
 * is disclosed on the plan rather than disappearing quietly.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  WorkPlanStore,
  WORK_PLAN_TERMINAL_ITEM_CAP,
  type WorkPlanItemStatus,
} from '@goodvibes-jev/engine/sdk/platform/workflow';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredItem {
  readonly id: string;
  readonly title: string;
  readonly status: WorkPlanItemStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

function withStore<T>(fn: (make: () => WorkPlanStore) => T): T {
  const homeDirectory = makeProjectTempDir('gv-work-plan-housekeeping');
  try {
    return fn(() => new WorkPlanStore({
      homeDirectory,
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      projectId: 'project:housekeeping',
      projectRoot: '/tmp/housekeeping',
    }));
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
}

function writePlanFile(filePath: string, body: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, 'utf8');
}

function storedItem(id: string, status: WorkPlanItemStatus, ageMs: number): StoredItem {
  const time = Date.now() - ageMs;
  return {
    id,
    title: `Item ${id}`,
    status,
    createdAt: time,
    updatedAt: time,
    ...(status === 'done' || status === 'cancelled' ? { completedAt: time } : {}),
  };
}

function writePlanWithItems(filePath: string, items: readonly StoredItem[], extra: Record<string, unknown> = {}): void {
  const time = Date.now();
  writePlanFile(filePath, `${JSON.stringify({
    id: 'wp-housekeeping',
    projectId: 'project:housekeeping',
    projectRoot: '/tmp/housekeeping',
    title: 'Work Plan',
    items,
    createdAt: time,
    updatedAt: time,
    ...extra,
  }, null, 2)}\n`);
}

/** The preserved copies of unreadable plan files sitting beside the plan. */
function quarantineFiles(filePath: string): string[] {
  const marker = `${basename(filePath)}.corrupt-`;
  return readdirSync(dirname(filePath)).filter((name) => name.startsWith(marker));
}

describe('the Agent work plan recovers from a bad file', () => {
  test('a zero-byte plan file degrades to an empty plan instead of throwing', () => {
    withStore((make) => {
      const seed = make();
      writePlanFile(seed.filePath, '');

      const store = make();
      expect(() => store.getActivePlan()).not.toThrow();
      expect(store.listItems()).toHaveLength(0);
      expect(store.getActivePlan().housekeeping?.resetFromUnreadableFile).toBe(true);
      // Nothing was worth preserving, so no recovery copy was made.
      expect(quarantineFiles(store.filePath)).toHaveLength(0);
      // Every public method stays usable rather than throwing out of readPlan.
      expect(store.clearCompleted()).toBe(0);
      expect(store.toMarkdown()).toContain('No work plan items recorded.');
    });
  });

  test('a crash-truncated plan file degrades to an empty plan, and the bad file is preserved', () => {
    withStore((make) => {
      const seed = make();
      writePlanFile(seed.filePath, '{"id":"wp-housekeeping","items":[{"id":"wpi-1","title":"Half w');

      const store = make();
      expect(store.listItems()).toHaveLength(0);
      const housekeeping = store.getActivePlan().housekeeping;
      expect(housekeeping?.resetFromUnreadableFile).toBe(true);
      // The user's unreadable list is kept where they can still get at it, and
      // the plan says where.
      expect(housekeeping?.quarantinePath).toBeTruthy();
      expect(existsSync(housekeeping!.quarantinePath!)).toBe(true);
      expect(readFileSync(housekeeping!.quarantinePath!, 'utf8')).toContain('Half w');
      // The reset is disclosed to the person reading the plan, not only to code.
      expect(store.toMarkdown()).toContain('Housekeeping');

      // Still writable afterwards.
      const item = store.addItem('Recovered work');
      expect(make().listItems().map((entry) => entry.id)).toEqual([item.id]);
    });
  });

  test('a plan file that is valid JSON but not a plan is treated the same way', () => {
    withStore((make) => {
      const seed = make();
      writePlanFile(seed.filePath, '[1,2,3]\n');

      const store = make();
      expect(store.listItems()).toHaveLength(0);
      expect(store.getActivePlan().housekeeping?.resetFromUnreadableFile).toBe(true);
      expect(quarantineFiles(store.filePath)).toHaveLength(1);
    });
  });
});

describe('the Agent work plan stays bounded without touching open work', () => {
  test('finished items age out while open work of the same age survives', () => {
    withStore((make) => {
      const seed = make();
      writePlanWithItems(seed.filePath, [
        storedItem('wpi-old-done', 'done', 60 * DAY_MS),
        storedItem('wpi-old-cancelled', 'cancelled', 60 * DAY_MS),
        storedItem('wpi-old-pending', 'pending', 60 * DAY_MS),
        storedItem('wpi-old-in-progress', 'in_progress', 200 * DAY_MS),
        storedItem('wpi-old-blocked', 'blocked', 200 * DAY_MS),
        storedItem('wpi-old-failed', 'failed', 200 * DAY_MS),
        storedItem('wpi-recent-done', 'done', 2 * DAY_MS),
      ]);

      const store = make();
      const items = store.listItems().map((item) => item.id);

      // pending / in_progress / blocked / failed are work the user still has
      // open at any age; only done and cancelled are ever reclaimed.
      expect(items).toEqual([
        'wpi-old-pending',
        'wpi-old-in-progress',
        'wpi-old-blocked',
        'wpi-old-failed',
        'wpi-recent-done',
      ]);
      expect(store.getActivePlan().housekeeping?.expiredItems).toBe(2);

      const persisted = JSON.parse(readFileSync(store.filePath, 'utf8')) as { readonly items: readonly { readonly id: string }[] };
      expect(persisted.items.map((item) => item.id)).toEqual(items);
    });
  });

  test('finished items are capped newest-first, and open items are not counted against the cap', () => {
    withStore((make) => {
      const seed = make();
      const overflow = 30;
      const total = WORK_PLAN_TERMINAL_ITEM_CAP + overflow;
      const done = Array.from({ length: total }, (_, index) => storedItem(`wpi-done-${index}`, 'done', (total - index) * 60_000));
      const open = Array.from({ length: 5 }, (_, index) => storedItem(`wpi-open-${index}`, 'pending', 5 * DAY_MS));
      writePlanWithItems(seed.filePath, [...done, ...open]);

      const store = make();
      const items = store.listItems();
      const keptDone = items.filter((item) => item.status === 'done');

      expect(keptDone).toHaveLength(WORK_PLAN_TERMINAL_ITEM_CAP);
      expect(items.filter((item) => item.status === 'pending')).toHaveLength(5);
      expect(store.getActivePlan().housekeeping?.cappedItems).toBe(overflow);
      // The oldest finished items are the ones dropped.
      expect(keptDone.some((item) => item.id === 'wpi-done-0')).toBe(false);
      expect(keptDone.some((item) => item.id === `wpi-done-${total - 1}`)).toBe(true);
    });
  });

  test('sweeping a second time reclaims nothing and rewrites nothing', () => {
    withStore((make) => {
      const seed = make();
      writePlanWithItems(seed.filePath, [
        storedItem('wpi-old-done', 'done', 60 * DAY_MS),
        storedItem('wpi-open', 'pending', 60 * DAY_MS),
      ]);

      const first = make();
      expect(first.listItems().map((item) => item.id)).toEqual(['wpi-open']);
      expect(first.getActivePlan().housekeeping?.expiredItems).toBe(1);
      const afterFirst = readFileSync(first.filePath, 'utf8');

      const second = make();
      expect(second.listItems().map((item) => item.id)).toEqual(['wpi-open']);
      // The disclosure from the first sweep is carried forward untouched: the
      // second sweep found nothing, so it neither reclaims nor rewrites.
      expect(readFileSync(second.filePath, 'utf8')).toBe(afterFirst);
    });
  });

  test('an active-item pointer aimed at a reclaimed item is cleared, not moved to another item', () => {
    withStore((make) => {
      const seed = make();
      writePlanWithItems(
        seed.filePath,
        [storedItem('wpi-old-done', 'done', 60 * DAY_MS), storedItem('wpi-open', 'pending', DAY_MS)],
        { activeItemId: 'wpi-old-done' },
      );

      const store = make();
      const plan = store.getActivePlan();
      // Nothing is active. Repointing at whatever item happened to survive
      // would claim the user is working on something they never selected.
      expect(plan.activeItemId).toBeUndefined();
      expect(plan.items.map((item) => item.id)).toEqual(['wpi-open']);
    });
  });
});
