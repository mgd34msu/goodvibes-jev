/**
 * settings-bundle-risk.test.ts
 *
 * A staged managed settings bundle's risk is the highest
 * `engine.runtime.settings-risk` reading over its changed settings, one
 * choice per changed setting. A reading that does not settle counts as high;
 * unchanged settings are not asked; a bundle that changes nothing is low; a
 * read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { readBundleRisk, type ManagedBundleChange } from '../sdk/src/platform/runtime/settings/control-plane-store.ts';
import type { ConfigKey } from '../sdk/src/platform/config/index.ts';

type RiskState = { readonly key: string };

function change(key: string, changed = true): ManagedBundleChange {
  return { key: key as ConfigKey, previousValue: 'a', nextValue: 'b', changed, locked: true, source: 'managed:test', reason: 'test' };
}

/** A port answering each setting's risk from `answers`, with a confidence per key, recording the keys asked. */
function riskPort(answers: Record<string, [string, number]>, asked: string[]) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name !== 'risk') throw new Error(`settings risk port: unexpected question ${name}`);
    const key = (state as unknown as RiskState).key;
    asked.push(key);
    const [choice, confidence] = answers[key] ?? ['low', 0.95];
    return choiceAnswer(question, choice, confidence);
  }).port;
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('readBundleRisk', () => {
  test('the bundle takes the highest settled reading', async () => {
    const asked: string[] = [];
    installJudgmentPort(riskPort({ 'display.theme': ['low', 0.95], 'provider.model': ['medium', 0.95] }, asked));
    expect(await readBundleRisk([change('display.theme'), change('provider.model')], 'test')).toBe('medium');
    expect(asked.sort()).toEqual(['display.theme', 'provider.model']);
  });

  test('one high change makes the bundle high', async () => {
    installJudgmentPort(riskPort({ 'permissions.mode': ['high', 0.95] }, []));
    expect(await readBundleRisk([change('display.theme'), change('permissions.mode')], 'test')).toBe('high');
  });

  test('a reading that does not settle counts as high', async () => {
    installJudgmentPort(riskPort({ 'display.theme': ['low', 0.4] }, []));
    expect(await readBundleRisk([change('display.theme')], 'test')).toBe('high');
  });

  test('unchanged settings are not asked, and a bundle that changes nothing is low', async () => {
    const asked: string[] = [];
    installJudgmentPort(riskPort({}, asked));
    expect(await readBundleRisk([change('permissions.mode', false)], 'test')).toBe('low');
    expect(asked).toEqual([]);
  });

  test('a read with no port installed throws', async () => {
    await expect(readBundleRisk([change('display.theme')], 'test')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
