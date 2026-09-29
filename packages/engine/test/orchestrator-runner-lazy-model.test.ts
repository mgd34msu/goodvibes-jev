/**
 * An agent routed to its own model (every contract unit) must not fail
 * because the configured default model cannot be found, for example while
 * the provider catalog is still loading: the contract runner's live proof saw
 * a resumed unit fail with "Current model ... not in registry" although its
 * route named another model. The run looks the default up only when an agent
 * without a model of its own reads it.
 */
import { expect, test } from 'bun:test';
import { lazyCurrentModel } from '../sdk/src/platform/agents/orchestrator-runner.ts';

test('the default model is not looked up until it is read, and then once', () => {
  let lookups = 0;
  const current = lazyCurrentModel({
    getCurrentModel: () => {
      lookups += 1;
      return { id: 'default-model', provider: 'default', registryKey: 'default:default-model' };
    },
  });
  expect(lookups).toBe(0);
  expect(current.registryKey).toBe('default:default-model');
  expect(current.provider).toBe('default');
  expect(lookups).toBe(1);
});

test('a default that cannot be found fails only the read that needs it', () => {
  const current = lazyCurrentModel({ getCurrentModel: () => { throw new Error("Current model 'x:y' not in registry."); } });
  expect(() => current.registryKey).toThrow('not in registry');
});
