/**
 * The fleet operator verbs over contracts (docs/design/contract-runner.md
 * 8.3), on a real runner in worktree mode: `fleet.attempts.*`,
 * `fleet.graph.get` and `fleet.conflicts.*` see contract-qualified ids
 * (`<contractId>:<id>`), and an operator's pick of a contract attempt closes
 * the unit's attempts-undecided escalation and takes the attempt as the
 * owner's pick would.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { AttemptError } from '../../sdk/src/platform/orchestration/attempts.js';
import { qualifyId, splitQualifiedId } from '../../sdk/src/platform/contract/index.js';
import type { AnswerContext } from './plan-support.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type AgentScript, type Harness } from './runner-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const writes = (text: string): AgentScript => () => [{ files: { 'src/csv.ts': text }, text: `parser written: ${text.trim()}` }];

/** The selection reads none, so the unit's attempts go to the owner. */
function noneSelected(context: AnswerContext): unknown {
  if (context.state['candidates'] === undefined) return undefined;
  if (context.name === 'pick') return choiceAnswer(context.question, 'none', 0.9);
  return undefined;
}

function git(cwd: string, ...args: string[]): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).stdout;
}

describe('qualified ids', () => {
  test('a qualified id splits back into its contract and engine-local id', () => {
    expect(qualifyId('ctr-1a2b3c4d', 'u1#a0')).toBe('ctr-1a2b3c4d:u1#a0');
    expect(splitQualifiedId('ctr-1a2b3c4d:u1#a0')).toEqual({ contractId: 'ctr-1a2b3c4d', id: 'u1#a0' });
    expect(splitQualifiedId('g1')).toBeNull();
    expect(splitQualifiedId(':g1')).toBeNull();
    expect(splitQualifiedId('ctr-1a2b3c4d:')).toBeNull();
  });
});

describe('the fleet verbs through the runner', () => {
  test('an operator pick of an undecided attempt closes the escalation and the unit passes with that attempt', async () => {
    const h = makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      scripts: { 'u1#a0': writes('export const parse = 0;\n'), 'u1#a1': writes('export const parse = 1;\n') },
      port: noneSelected,
    });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => h.store.get(contract.id)?.status === 'awaiting-owner', 'the attempts to go to the owner', 20_000);
    const controls = h.runner.fleetControls();

    const groups = await controls.listHeldMergeGroups();
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.groupId.startsWith(`${contract.id}:`)).toBe(true);
    expect(group.workstreamId).toBe(`${contract.id}:g1`);
    expect(group.candidates.map((candidate) => candidate.itemId).sort()).toEqual([`${contract.id}:u1#a0`, `${contract.id}:u1#a1`]);
    expect(await controls.listHeldMergeGroups(`${contract.id}:g1`)).toHaveLength(1);
    expect(await controls.listHeldMergeGroups('ctr-00000000:g1')).toEqual([]);

    const graph = controls.getGraphSnapshot(`${contract.id}:g1`);
    expect(graph?.workstreamId).toBe(`${contract.id}:g1`);
    expect(graph?.nodes.every((node) => node.id.startsWith(`${contract.id}:`))).toBe(true);
    expect(controls.getGraphSnapshot('g1')).toBeNull();
    expect(controls.listWorkstreams().map((workstream) => workstream.id)).toEqual([`${contract.id}:g1`]);

    // Refused: an id without its contract, and an attempt that is not a candidate.
    await expect(controls.pickAttemptWinner(group.groupId.split(':')[1]!, 'u1#a1')).rejects.toBeInstanceOf(AttemptError);
    await expect(controls.pickAttemptWinner(group.groupId, `${contract.id}:u1#a7`)).rejects.toThrow('not a passing attempt');

    const picked = await controls.pickAttemptWinner(group.groupId, `${contract.id}:u1#a1`);
    expect(picked).toEqual({ groupId: group.groupId, winnerItemId: `${contract.id}:u1#a1`, loserItemIds: [`${contract.id}:u1#a0`], auto: false });
    await waitFor(() => h.store.get(contract.id)?.status === 'passed', 'the contract to pass', 20_000);
    const done = h.store.get(contract.id)!;
    expect(done.escalations.every((escalation) => escalation.resolvedAt !== undefined)).toBe(true);
    expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a1');
    expect(done.decisions.find((decision) => decision.action === 'attempts-selected')?.reason).toContain('picked by the operator');
    expect(git(h.root, 'show', `${done.branch!}:src/csv.ts`)).toBe('export const parse = 1;\n');
  });

  test('verbs naming a contract that is not running find nothing or are refused', async () => {
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: {} });
    harness = h;
    const controls = h.runner.fleetControls();
    expect(await controls.listHeldMergeGroups()).toEqual([]);
    expect(controls.listWorkstreams()).toEqual([]);
    expect(controls.stampConflictSession('ctr-00000000:u1', 'session-9')).toBe(false);
    expect(await controls.retryItemIntegration('ctr-00000000:u1')).toBe('not-conflicted');
    await expect(controls.proposeAttemptWinner('ctr-00000000:boN-1')).rejects.toBeInstanceOf(AttemptError);
  });
});
