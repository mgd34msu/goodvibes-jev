import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('compound-settings-owner'); roots.push(root);
  const config = new ConfigManager({ surfaceRoot: 'agent', homeDir: root });
  config.set('voice.wake.enabled', false); config.set('voice.wake.surfaces.agent', false);
  const mutation = config.prepareSettingMutationPlan([
    { operation: 'set', key: 'voice.wake.enabled', value: true },
    { operation: 'set', key: 'voice.wake.surfaces.agent', value: true },
  ]);
  return { config, mutation };
}
test('all ordered companion effects are captured and share exactly one transition', () => {
  const { config, mutation } = fixture(); const facts = config.inspectPreparedMutation(mutation);
  expect(facts.effects?.map(effect => effect.key)).toEqual(['voice.wake.enabled', 'voice.wake.surfaces.agent']);
  const transition = config.beginPreparedMutation(mutation); let checks = 0;
  const receipt = config.finishPreparedMutation(mutation, transition, () => { checks++; config.assertPreparedMutationTransition(mutation, transition); });
  expect(receipt.status).toBe('committed'); expect(checks).toBe(2); expect(config.getConfigurationIncarnation()).toBe(facts.incarnation + 1);
  expect(config.get('voice.wake.enabled')).toBe(true); expect(config.get('voice.wake.surfaces.agent')).toBe(true);
  expect(() => config.finishPreparedMutation(mutation, transition)).toThrow();
});
test('a reentrant finish cannot replay the compound plan while its transition is guarded', () => {
  const { config, mutation } = fixture(); const transition = config.beginPreparedMutation(mutation); let denied = 0;
  const off = config.subscribe('voice.wake.enabled', () => {
    try { config.finishPreparedMutation(mutation, transition); } catch { denied++; }
  });
  const receipt = config.finishPreparedMutation(mutation, transition, () => config.assertPreparedMutationTransition(mutation, transition)); off();
  expect(receipt.status).toBe('committed'); expect(denied).toBe(1);
});
test('an unrelated same-owner ABA between physical effects stops the tail', () => {
  const { config, mutation } = fixture(); const transition = config.beginPreparedMutation(mutation);
  const off = config.subscribe('voice.wake.enabled', () => { config.set('behavior.saveHistory', false); config.set('behavior.saveHistory', true); });
  const receipt = config.finishPreparedMutation(mutation, transition, () => config.assertPreparedMutationTransition(mutation, transition)); off();
  expect(receipt.status).toBe('partial'); expect(receipt.completedPaths).toHaveLength(1);
  expect(config.get('voice.wake.enabled')).toBe(true); expect(config.get('voice.wake.surfaces.agent')).toBe(false);
});
