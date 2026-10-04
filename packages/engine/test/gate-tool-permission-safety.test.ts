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

  test('category input is captured before the cancellation helper yields', async () => {
    const args = { mode: 'summary' };
    const pending = readPermissionCategory('agent_harness', args);
    args.mode = 'learning_auto_promote';
    expect(await pending).toEqual({ category: 'read', confident: true });
    expect(JSON.stringify(requests[0])).toContain('summary');
    expect(JSON.stringify(requests[0])).not.toContain('learning_auto_promote');
  });

  test('category cancellation reaches Jev and discards a late non-cooperative answer', async () => {
    const controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let seenSignal: AbortSignal | undefined;
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'read', 0.99));
    installJudgmentPort({ model: fixture.port.model, async ask(request) {
      seenSignal = request.signal; enter(); await pending; return fixture.port.ask(request);
    } });
    const outcome = readPermissionCategory('read', {}, undefined, controller.signal).catch((error: unknown) => error);
    await entered;
    expect(seenSignal).toBe(controller.signal);
    controller.abort('private caller reason');
    expect(await outcome).toMatchObject({ name: 'JudgmentError', kind: 'aborted' });
    expect(JSON.stringify(await outcome)).not.toContain('private caller reason');
    release();
    await Bun.sleep(0);
    expect(await outcome).toMatchObject({ kind: 'aborted' });
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

  for (const tool of ['read', 'fetch', 'agent_harness']) {
    test(`${tool}: a manager failure is never replaced by a category allowance`, async () => {
      const manager = throwingPermissionManager();
      installPermissionManagerSafetyGuard(manager);
      await expect(manager.check(tool, { mode: 'summary' })).rejects.toThrow('category table unavailable');
      await expect(manager.checkDetailed(tool, { mode: 'summary' })).rejects.toThrow('category table unavailable');
      expect(requests).toHaveLength(0);
    });
  }

  test('installing twice wraps once and leaves category authority untouched', async () => {
    const manager = denyingPermissionManager();
    const getCategory = manager.getCategory;
    installPermissionManagerSafetyGuard(manager);
    const check = manager.check;
    installPermissionManagerSafetyGuard(manager);
    expect(manager.check).toBe(check);
    expect(manager.getCategory).toBe(getCategory);
    expect(await manager.check('read', {})).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
