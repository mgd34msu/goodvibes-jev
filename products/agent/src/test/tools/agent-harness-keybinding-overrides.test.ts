import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { resetHarnessKeybinding, setHarnessKeybinding } from '../../tools/agent-harness-keybinding-metadata.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface KeybindingFixture {
  readonly configPath: string;
  readonly manager: KeybindingsManager;
  readonly context: Parameters<typeof setHarnessKeybinding>[0];
}

async function withKeybindings<T>(fn: (fixture: KeybindingFixture) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-keybinding-overrides');
  const configPath = join(root, 'agent', 'keybindings.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const manager = new KeybindingsManager({ configPath });
  const context = { workspace: { keybindingsManager: manager } };
  try {
    return await fn({ configPath, manager, context });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readOverrides(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

describe('agent harness keybinding override file', () => {
  test('writes an override atomically and leaves no temp file behind', async () => {
    await withKeybindings(async ({ configPath, manager, context }) => {
      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: true } });

      expect(result.status).toBe('updated');
      expect(readOverrides(configPath).search).toBeDefined();
      expect(manager.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
      expect(readdirSync(dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    });
  });

  test('degrades a crash-truncated overrides file to no overrides instead of throwing', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      writeFileSync(configPath, '{"search": [{"key": "g", "ctr');

      await expect(setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'j', ctrl: true } })).resolves.toMatchObject({ status: 'updated' });
      expect(readOverrides(configPath)).toEqual({ search: { key: 'j', ctrl: true } });
      // The unreadable file was preserved rather than silently discarded.
      expect(existsSync(`${configPath}.corrupt`)).toBe(true);
    });
  });

  test('degrades a zero-byte overrides file to no overrides', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      writeFileSync(configPath, '');

      const result = await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'k', ctrl: true } });
      expect(result.status).toBe('updated');
      expect(readOverrides(configPath)).toEqual({ search: { key: 'k', ctrl: true } });
      // An empty file carries nothing worth preserving, so nothing is quarantined.
      expect(existsSync(`${configPath}.corrupt`)).toBe(false);
    });
  });

  test('degrades an overrides file that is valid JSON but not an object', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      writeFileSync(configPath, '["search"]\n');

      await expect(resetHarnessKeybinding(context, { actionId: 'search' })).resolves.toMatchObject({ status: 'reset' });
      expect(readOverrides(configPath)).toEqual({});
      expect(existsSync(`${configPath}.corrupt`)).toBe(true);
    });
  });

  test('keeps unrelated overrides when resetting one action', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: true } });
      await setHarnessKeybinding(context, { actionId: 'screen-clear', combo: { key: 'l', ctrl: true } });
      await resetHarnessKeybinding(context, { actionId: 'search' });

      const overrides = readOverrides(configPath);
      expect(overrides.search).toBeUndefined();
      expect(overrides['screen-clear']).toBeDefined();
    });
  });
});

function modifierReadings(choice: 'true' | 'false' | 'neither', probability = 0.999) {
  return fakePort((_name, question) => {
    if (question.type !== 'choice') throw new Error('Unexpected modifier reading');
    return choiceAnswer(question, Object.hasOwn(question.criteria, 'neither') ? choice : 'other', probability);
  });
}

describe('keybinding modifier interpretation before durable writes', () => {
  test('a scripted canonical choice controls the actual modifier instead of the old word shortcut', async () => {
    await withKeybindings(async ({ configPath, manager, context }) => {
      const fake = modifierReadings('false'); installJudgmentPort(fake.port);
      await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: 'on' } }, { sourceOwner: ordinaryResearchOwner() });
      expect(readOverrides(configPath)).toEqual({ search: { key: 'g', ctrl: false } });
      expect(manager.matches('search', { logicalName: 'g' })).toBe(true);
      expect(fake.requests.find(request => request.context?.battery === 'engine.tools.boolean-value')?.state).toMatchObject({
        parameter: 'ctrl', value: 'on', evidence: { arguments: { actionId: 'search', combo: { key: 'g', ctrl: 'on' } } },
      });
    });
  });

  test('native JSON modifiers and Ctrl+G grammar remain usable without a reader', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      await setHarnessKeybinding(context, { actionId: 'search', fields: { key: 'g', ctrl: true, shift: false } });
      expect(readOverrides(configPath)).toEqual({ search: { key: 'g', ctrl: true, shift: false } });
      await setHarnessKeybinding(context, { actionId: 'search', value: 'Ctrl+G' });
      expect(readOverrides(configPath)).toEqual({ search: { key: 'g', ctrl: true } });
      await setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: 'false' } });
      expect(readOverrides(configPath)).toEqual({ search: { key: 'g', ctrl: false } });
    });
  });

  test('missing or unsettled modifier readings leave the override file absent', async () => {
    await withKeybindings(async ({ configPath, context }) => {
      const args = { actionId: 'search', combo: { key: 'g', ctrl: 'on' } }, options = { sourceOwner: ordinaryResearchOwner() };
      await expect(setHarnessKeybinding(context, args, options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
      expect(existsSync(configPath)).toBe(false);
      for (const fake of [modifierReadings('neither'), modifierReadings('true', 0.5)]) {
        installJudgmentPort(fake.port);
        await expect(setHarnessKeybinding(context, args, options)).rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(existsSync(configPath)).toBe(false);
      }
    });
  });

  for (const retirement of ['cancelled', 'caller-retired', 'arguments-changed', 'reader-retired'] as const) {
    test(`a pending modifier reading makes no override write after ${retirement}`, async () => {
      await withKeybindings(async ({ configPath, context }) => {
        const fake = modifierReadings('true'), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
        const controller = new AbortController(), reason = new ToolInputProjectionError('held'); let retired = false;
        const args = { actionId: 'search', combo: { key: 'g', ctrl: 'on' } };
        installJudgmentPort({ ...fake.port, async ask(request) {
          if (request.context?.battery === 'engine.tools.boolean-value') { entered.resolve(); await released.promise; }
          return fake.port.ask(request);
        } });
        const outcome = setHarnessKeybinding(context, args, { sourceOwner: ordinaryResearchOwner(), signal: controller.signal,
          assertCurrent() { if (retired) throw reason; } }).then(value => ({ kind: 'returned' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }));
        try {
          const first = await Promise.race([entered.promise.then(() => 'entered' as const), outcome]);
          if (first !== 'entered') throw new Error('Modifier operation ended before its pending read');
          if (retirement === 'cancelled') controller.abort(reason);
          else if (retirement === 'caller-retired') retired = true;
          else if (retirement === 'arguments-changed') args.combo.key = 'j';
          else installJudgmentPort(modifierReadings('true').port);
          released.resolve();
          expect((await outcome).kind).toBe('rejected');
          expect(existsSync(configPath)).toBe(false);
        } finally { released.resolve(); await outcome; }
      });
    });
  }
});
