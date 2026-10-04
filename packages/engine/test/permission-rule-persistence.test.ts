/** Remembered permission state is published only after its file write commits. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { makeControllableStore, readOnDisk, replaceInternalStore } from './_helpers/controllable-store.ts';
import { waitFor } from './_helpers/test-timeout.ts';
import { buildDurableRuleForDecision } from '../sdk/src/platform/permissions/approval-rules.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../sdk/src/platform/permissions/prompt.ts';
import { UserPermissionRuleStore, type StoredUserPermissionRule } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';

useGateReadings();

interface RuleFile extends Record<string, unknown> {
  readonly version: 1;
  readonly rules: readonly StoredUserPermissionRule[];
}

const args = (command: string) => ({ commands: [{ cmd: command }] });
const command = 'git commit -m synthetic';

function record(id: string, effect: 'allow' | 'deny' = 'allow'): StoredUserPermissionRule {
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args: args(command), tier: 'exact', effect })!;
  return { rule: { ...rule, id }, createdAt: 1, tier: 'exact', tool: 'exec' };
}

function manager(store: UserPermissionRuleStore, handler: PermissionRequestHandler): PermissionManager {
  return new PermissionManager(handler, {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/synthetic/persistence',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as PermissionConfigReader, new PolicyRuntimeState(), null, null, store);
}

describe('remembered permission persistence', () => {
  test('a real rename failure never becomes a live grant or a later persisted success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-permission-persistence-'));
    const path = join(dir, 'rules.json');
    try {
      const store = new UserPermissionRuleStore(path);
      await store.init();
      // A directory at the target lets the temp write/fsync succeed and makes
      // the actual atomic rename fail. All files belong to this test.
      mkdirSync(path);
      let asks = 0;
      const permissions = manager(store, async () => ++asks === 1
        ? { approved: true, rememberTier: 'exact' }
        : { approved: false });
      const error = await permissions.checkDetailed('exec', args(command)).then(() => null, (cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'EISDIR', syscall: 'rename' });
      const repeated = await permissions.checkDetailed('exec', args(command));
      expect(repeated).toMatchObject({
        approved: false, persisted: false, sourceLayer: 'user_prompt', reasonCode: 'user_denied',
      });
      expect(asks).toBe(2);
      expect(store.list()).toEqual([]);
      expect(store.rules()).toEqual([]);
      expect(readdirSync(dir)).toEqual(['rules.json']);
      rmSync(path, { recursive: true });

      // The failed transaction does not poison the queue or reappear on retry.
      const retry = manager(store, async () => ({ approved: true, rememberTier: 'exact' }));
      expect(await retry.checkDetailed('exec', args(command))).toMatchObject({ approved: true, persisted: true });
      expect(store.list()).toHaveLength(1);
      const reopened = new UserPermissionRuleStore(path);
      await reopened.init();
      expect(reopened.list()).toEqual(store.list());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pending grant is not visible to another permission consumer', async () => {
    const fixture = makeControllableStore<RuleFile>('pending-permission');
    try {
      const store = new UserPermissionRuleStore(fixture.path);
      replaceInternalStore(store, 'store', fixture.store);
      await store.init();
      fixture.store.delayNextMs = 100;
      fixture.store.failNext = true;
      const granting = manager(store, async () => ({ approved: true, rememberTier: 'exact' }));
      const pending = granting.checkDetailed('exec', args(command)).then(() => null, (error: unknown) => error);
      await waitFor(() => fixture.store.started === 1);
      expect(store.list()).toEqual([]);
      let asks = 0;
      const matching = manager(store, async () => { asks++; return { approved: false }; });
      expect(await matching.checkDetailed('exec', args(command))).toMatchObject({
        approved: false, persisted: false, sourceLayer: 'user_prompt',
      });
      expect(asks).toBe(1);
      expect(await pending).toMatchObject({ message: 'store unavailable' });
      expect(store.rules()).toEqual([]);
      expect(readOnDisk<RuleFile>(fixture.path)).toBeNull();
    } finally { fixture.cleanup(); }
  });

  test('a queued successful add excludes an earlier failed add and preserves committed records', async () => {
    const fixture = makeControllableStore<RuleFile>('failed-permission-add');
    try {
      const store = new UserPermissionRuleStore(fixture.path);
      replaceInternalStore(store, 'store', fixture.store);
      await store.init();
      await store.add(record('existing', 'deny'));
      fixture.store.failNext = true;
      const failed = store.add(record('failed')).then(() => null, (error: unknown) => error);
      const succeeding = store.add(record('succeeded'));
      expect(await failed).toMatchObject({ message: 'store unavailable' });
      await succeeding;
      expect(store.rules().map((rule) => rule.id)).toEqual(['existing', 'succeeded']);
      expect(readOnDisk<RuleFile>(fixture.path)?.rules).toEqual(store.list());
      const reopened = new UserPermissionRuleStore(fixture.path);
      await reopened.init();
      expect(reopened.list()).toEqual(store.list());
    } finally { fixture.cleanup(); }
  });

  test('overlapping successful additions accumulate only committed records', async () => {
    const fixture = makeControllableStore<RuleFile>('concurrent-permission-add');
    try {
      const store = new UserPermissionRuleStore(fixture.path);
      replaceInternalStore(store, 'store', fixture.store);
      await store.init();
      fixture.store.delayNextMs = 50;
      const first = store.add(record('first'));
      const second = store.add(record('second'));
      await waitFor(() => fixture.store.started === 1);
      expect(store.rules()).toEqual([]);
      await Promise.all([first, second]);
      expect(store.rules().map((rule) => rule.id)).toEqual(['first', 'second']);
      expect(readOnDisk<RuleFile>(fixture.path)?.rules).toEqual(store.list());
    } finally { fixture.cleanup(); }
  });

  test.each(['allow', 'deny'] as const)('failed deletion of a %s rule reports failure and keeps the committed state retryable', async (effect) => {
    const fixture = makeControllableStore<RuleFile>('failed-permission-delete');
    try {
      const store = new UserPermissionRuleStore(fixture.path);
      replaceInternalStore(store, 'store', fixture.store);
      await store.init();
      const existing = record('existing', effect);
      await store.add(existing);
      fixture.store.failNext = true;
      const failed = store.delete('existing').then(() => null, (error: unknown) => error);
      const adding = store.add(record('later'));
      expect(await failed).toMatchObject({ message: 'store unavailable' });
      await adding;
      expect(store.list()).toEqual([existing, record('later')]);
      expect(readOnDisk<RuleFile>(fixture.path)?.rules).toEqual(store.list());
      expect(await store.delete('existing')).toBe(true);
      expect(await store.delete('existing')).toBe(false);
      expect(store.rules().map((rule) => rule.id)).toEqual(['later']);
      const reopened = new UserPermissionRuleStore(fixture.path);
      await reopened.init();
      expect(reopened.list()).toEqual(store.list());
    } finally { fixture.cleanup(); }
  });

  test('a queued deletion cannot report success for a failed uncommitted addition', async () => {
    const fixture = makeControllableStore<RuleFile>('absent-permission-delete');
    try {
      const store = new UserPermissionRuleStore(fixture.path);
      replaceInternalStore(store, 'store', fixture.store);
      await store.init();
      fixture.store.failNext = true;
      const failed = store.add(record('failed')).then(() => null, (error: unknown) => error);
      const removed = store.delete('failed');
      expect(await failed).toMatchObject({ message: 'store unavailable' });
      expect(await removed).toBe(false);
      expect(fixture.store.started).toBe(1);
      expect(store.list()).toEqual([]);
      expect(readOnDisk<RuleFile>(fixture.path)).toBeNull();
    } finally { fixture.cleanup(); }
  });
});
