/**
 * hooks-runner-agent.test.ts
 *
 * The agent hook runner over the real AgentManager and the real contract
 * runner (test/contract/runner-support.ts: real manager, message bus, runtime
 * bus, orchestration engine and contract store, a scripted executor in place
 * of the model loop, and the fake judgment port). The hook's spawn starts a
 * contract, the contract runs, and:
 *
 *  - when it passes, the hook succeeds with the contract's answer as its
 *    additionalContext (not the owner's operator progress line);
 *  - when it outlives the hook's timeout, the hook cancels the owner record,
 *    and the contract and its unit agent stop.
 */
import { afterEach, expect, test } from 'bun:test';
import { run } from '../sdk/src/platform/hooks/runners/agent.ts';
import type { HookDefinition, HookEvent } from '../sdk/src/platform/hooks/types.ts';
import { ASK, makeHarness, oneUnitPlan, waitFor, type Harness } from './contract/runner-support.ts';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const EVENT: HookEvent = {
  path: 'Post:tool:write',
  phase: 'Post',
  category: 'tool',
  specific: 'write',
  sessionId: 'session-hook',
  timestamp: 1,
  payload: { path: 'src/csv.ts' },
};

function hook(timeoutSeconds: number): HookDefinition {
  return { match: 'Post:tool:write', type: 'agent', prompt: `${ASK} Event: $ARGUMENTS`, timeout: timeoutSeconds };
}

function owners(h: Harness) {
  return h.manager.list().filter((record) => record.contractRole === 'owner');
}

test('an agent hook runs its contract to a pass and returns the contract answer as additionalContext', async () => {
  const h = (harness = makeHarness({
    plan: oneUnitPlan(1),
    scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = (t: string) => t.split(",");\n' }, text: 'The CSV parser is in src/csv.ts.' }] },
  }));
  h.manager.setContractRunner(h.runner);

  const result = await run(hook(5), EVENT, h.manager);

  const [owner] = owners(h);
  expect(owner).toBeDefined();
  expect(owner!.task).toContain('"path":"Post:tool:write"');
  expect(owner!.status).toBe('completed');
  expect(h.store.get(owner!.contractId!)!.status).toBe('passed');
  expect(result).toEqual({ ok: true, additionalContext: 'The CSV parser is in src/csv.ts.' });
  // The operator line is what the hook used to hand back.
  expect(owner!.progress).not.toBe('The CSV parser is in src/csv.ts.');
});

test('an agent hook that times out cancels the owner record, and the contract and its unit agent stop', async () => {
  const h = (harness = makeHarness({
    plan: oneUnitPlan(1),
    scripts: { u1: () => [{ text: 'working', stop: { kind: 'hang' } }] },
  }));
  h.manager.setContractRunner(h.runner);

  const result = await run(hook(0.5), EVENT, h.manager);

  expect(result.ok).toBe(false);
  expect(result.error).toContain('agent hook timed out after 0.5s');
  const [owner] = owners(h);
  expect(owner!.status).toBe('cancelled');
  const contractId = owner!.contractId!;
  await waitFor(() => h.store.get(contractId)?.status === 'cancelled', 'the contract to be cancelled');
  const unitAgent = h.store.get(contractId)!.units[0]!.agentIds[0]!;
  await waitFor(() => h.manager.getStatus(unitAgent)?.status === 'cancelled', 'the unit agent to be stopped');
});
