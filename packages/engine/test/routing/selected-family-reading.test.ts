import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withinSelectedFamily } from '../../sdk/src/platform/routing/route-scope.js';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.js';
const selected = { id: 'selected', provider: 'test', registryKey: 'test:selected', displayName: 'Selected' } as ModelDefinition;
const alternate = { ...selected, id: 'alternate', registryKey: 'test:alternate' };
let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => { installJudgmentPort(previous); });
test('the exact selected model needs no family reading or configured port', async () => {
  previous = installJudgmentPort(undefined);
  expect(await withinSelectedFamily([selected], selected, {})).toEqual([selected]);
});
test('a weak yes cannot broaden the selected family and is not remembered as an acting result', async () => {
  let probability = 0.57;
  const fixture = fakePort(() => noulAnswer(probability)); previous = installJudgmentPort(fixture.port);
  expect(await withinSelectedFamily([selected, alternate], selected, {})).toEqual([selected]);
  probability = 0.99;
  expect(await withinSelectedFamily([selected, alternate], selected, {})).toEqual([selected, alternate]);
  expect(fixture.requests).toHaveLength(2);
});
