// Ported from goodvibes-agent src/test/runtime/tool-permission-safety.test.ts.
//
// The agent pinned about twenty hand-kept tables of tool names and action
// strings that classified a call when the permission manager threw. In the
// engine that classification is Jev's reading of the call's side-effect kind,
// so these tests answer the `kind` question with a fake port and pin what the
// guard composes from it: approve only a confident read, refuse everything
// else, and never approve without a reading.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { SideEffectKind } from '../sdk/src/platform/gate/batteries/side-effect.ts';
import type { PermissionCategory, PermissionCheckResult } from '../sdk/src/platform/permissions/types.ts';
import {
  installPermissionManagerSafetyGuard,
  readPermissionCategory,
  TOOL_PERMISSION_SAFETY_SITE,
} from '../sdk/src/platform/gate/policy/tool-permission-safety.ts';

/** What Jev reads for a call, keyed by text in the call; the confidence says how sure. */
const KINDS: ReadonlyArray<readonly [text: string, kind: SideEffectKind, confidence: number]> = [
  ['"summary"', 'read', 0.95],
  ['"learning_auto_promote"', 'write', 0.95],
  ['"docs_page"', 'network', 0.95],
  ['"kill"', 'shell', 0.95],
  ['"spawn"', 'delegation', 0.95],
  ['"navigate"', 'browser', 0.95],
  ['"unsure"', 'read', 0.4],
];

let requests: ReadonlyArray<{ readonly site?: string | undefined; readonly state: unknown }> = [];
let previous: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  const fake = fakePort((name: string, question: Question, state: unknown) => {
    if (name !== 'kind') throw new Error(`unexpected question ${name}`);
    const text = JSON.stringify(state);
    const [, kind, confidence] = KINDS.find(([match]) => text.includes(match)) ?? ['', 'other', 0.95];
    return choiceAnswer(question, kind, confidence);
  });
  requests = fake.requests as typeof requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  installJudgmentPort(previous);
});

type TestPermissionManager = {
  check(toolName: string, args: Record<string, unknown>): Promise<boolean>;
  checkDetailed(toolName: string, args: Record<string, unknown>): Promise<PermissionCheckResult>;
  getCategory(toolName: string, args?: Record<string, unknown>): PermissionCategory;
};

function throwingPermissionManager(): TestPermissionManager {
  return {
    check: async () => { throw new Error('category table unavailable'); },
    checkDetailed: async (): Promise<PermissionCheckResult> => { throw new Error('category table unavailable'); },
    getCategory: (): PermissionCategory => 'delegate',
  };
}

function denyingPermissionManager(): TestPermissionManager {
  return {
    check: async () => false,
    checkDetailed: async (): Promise<PermissionCheckResult> => ({
      approved: false,
      persisted: false,
      sourceLayer: 'runtime_mode',
      reasonCode: 'config_deny',
      analysis: { classification: 'generic', riskLevel: 'high', summary: 'deny', reasons: [] },
    }),
    getCategory: (): PermissionCategory => 'delegate',
  };
}

describe('readPermissionCategory: the side-effect kind, mapped to a category', () => {
  test('each kind maps to its category, with the reading\'s confidence', async () => {
    expect(await readPermissionCategory('agent_harness', { mode: 'summary' })).toEqual({ category: 'read', confident: true });
    expect(await readPermissionCategory('agent_harness', { mode: 'learning_auto_promote' })).toEqual({ category: 'write', confident: true });
    expect(await readPermissionCategory('process', { action: 'kill' })).toEqual({ category: 'execute', confident: true });
    expect(await readPermissionCategory('agent', { mode: 'spawn' })).toEqual({ category: 'delegate', confident: true });
    expect(await readPermissionCategory('browser', { action: 'navigate' })).toEqual({ category: 'execute', confident: true });
    expect(await readPermissionCategory('fetch', { url: 'docs_page' })).toEqual({ category: 'read', confident: true });
    expect(await readPermissionCategory('memory', { action: 'unsure' })).toEqual({ category: 'read', confident: false });
  });

  test('the reading is asked at the tool-permission-safety site, one question per call', async () => {
    await readPermissionCategory('agent_harness', { mode: 'summary' });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(TOOL_PERMISSION_SAFETY_SITE);
  });
});

describe('installPermissionManagerSafetyGuard', () => {
  test('a working manager answers for itself; no reading is asked', async () => {
    const manager = denyingPermissionManager();
    installPermissionManagerSafetyGuard(manager);
    await expect(manager.check('agent_harness', { mode: 'summary' })).resolves.toBe(false);
    expect((await manager.checkDetailed('agent_harness', { mode: 'summary' })).reasonCode).toBe('config_deny');
    expect(requests).toHaveLength(0);
  });

  test('when the manager throws, only a confident read is approved', async () => {
    const manager = throwingPermissionManager();
    installPermissionManagerSafetyGuard(manager);
    await expect(manager.check('agent_harness', { mode: 'summary' })).resolves.toBe(true);
    await expect(manager.check('fetch', { url: 'docs_page' })).resolves.toBe(true);
    await expect(manager.check('agent_harness', { mode: 'learning_auto_promote' })).resolves.toBe(false);
    await expect(manager.check('process', { action: 'kill' })).resolves.toBe(false);
    await expect(manager.check('agent', { mode: 'spawn' })).resolves.toBe(false);
    await expect(manager.check('browser', { action: 'navigate' })).resolves.toBe(false);
    // A read Jev is unsure of is not approved: doubt never approves.
    await expect(manager.check('memory', { action: 'unsure' })).resolves.toBe(false);
  });

  test('checkDetailed states the fallback: approval, reason code, risk and the manager\'s error', async () => {
    const manager = throwingPermissionManager();
    installPermissionManagerSafetyGuard(manager);

    const read = await manager.checkDetailed('agent_harness', { mode: 'summary' });
    expect(read.approved).toBe(true);
    expect(read.reasonCode).toBe('config_allow');
    expect(read.analysis.riskLevel).toBe('low');
    expect(read.analysis.reasons).toContain('permission-manager-exception');
    expect(read.analysis.summary).toBe('Permission fallback for agent_harness: category table unavailable');

    const mutating = await manager.checkDetailed('agent_harness', { mode: 'learning_auto_promote' });
    expect(mutating.approved).toBe(false);
    expect(mutating.reasonCode).toBe('config_deny');
    expect(mutating.analysis.riskLevel).toBe('high');
    expect(mutating.analysis.reasons).toContain('permission-manager-exception');
  });

  test('a failed reading is not an approval: the error reaches the caller', async () => {
    const manager = throwingPermissionManager();
    installPermissionManagerSafetyGuard(manager);
    installJudgmentPort(undefined);
    await expect(manager.check('agent_harness', { mode: 'summary' })).rejects.toThrow('judgment port');
  });

  test('installing twice wraps once, and the category lookup is left alone', async () => {
    const manager = throwingPermissionManager();
    const getCategory = manager.getCategory;
    installPermissionManagerSafetyGuard(manager);
    const check = manager.check;
    installPermissionManagerSafetyGuard(manager);
    expect(manager.check).toBe(check);
    expect(manager.getCategory).toBe(getCategory);
    await manager.check('agent_harness', { mode: 'summary' });
    expect(requests).toHaveLength(1);
  });
});
