import { expect, test } from 'bun:test';
import { nativeContractRoute } from '../../sdk/src/platform/contract/native-decisions.js';
import { nativeSourceCriteria } from '../../sdk/src/platform/contract/native-source.js';
import { createRoutePlannerContractSelector } from '../../sdk/src/platform/contract/route.js';
import { makeContract } from './fixtures.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';

test('review: native production route selector receives full original source rather than just display ask', async () => {
  const source: NativeContractSource = { sourceId: 'work', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Exact original parser goal', criteria: ['Preserve the first exact requirement', 'Preserve the second exact requirement'] };
  const contract = makeContract({ ask: 'Short display request', nativeSource: source, goal: source.goal, criteria: nativeSourceCriteria(source) });
  const requests: unknown[] = [];
  const selector = createRoutePlannerContractSelector({ planRoute: async request => { requests.push(request); return { model: 'provider:model', provider: 'provider', fallbackModels: [], reason: 'test' }; } });
  await nativeContractRoute(selector, contract, { host: { authorityOf: () => ({ authorityId: 'host', authorityRevision: '1', scopeId: 'scope', scopeRevision: '1' }) }, changed() {} }, { purpose: 'planner', contract }, new AbortController().signal);
  const input = JSON.stringify(requests[0]);
  console.log('REVIEW_ROUTING_INPUT', input);
  expect(input).toContain(source.goal);
  for (const criterion of source.criteria) expect(input).toContain(criterion);
});
