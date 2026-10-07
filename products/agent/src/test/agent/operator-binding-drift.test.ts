/**
 * operator-binding-drift.test.ts, every verb this product calls is bound to
 * the route the contract publishes for it, and nothing else.
 *
 * The failure this guards against does not look like a failure. A path moves in
 * the daemon, the contract moves with it, and a product carrying its own copy
 * keeps calling the old one, so an approval that will not approve, a schedule
 * that will not run, and a 404 that reads to an operator as a broken feature
 * rather than as a stale binding. The webui derives its table and drift-tests
 * it; this is the same guard for the Agent's three tables.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *  - DERIVATION: what the product will actually send equals what the contract
 *    says. This cannot drift while the tables are derived, the point is that it
 *    stays that way, so the test fails if someone re-hardcodes a path.
 *  - PRESENCE: every id the product depends on is still IN the contract. This
 *    is the one that catches a retired method, and it is why the ids are
 *    written out here in full rather than read back from the same table under
 *    test, a list that derives its own expectations proves nothing.
 */

import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { getOperatorActions, OPERATOR_ACTION_IDS } from '../../agent/operator-actions.ts';
import {
  OPERATOR_BRIEFING_METHOD_IDS,
  operatorBriefingRoutes,
} from '../../tools/agent-operator-briefing-tool.ts';
import { connectedHostRouteFamilies } from '../../tools/agent-harness-connected-host-capabilities.ts';

interface ContractMethod {
  readonly id: string;
  readonly http?: { readonly method?: string; readonly path?: string };
}

function contractMethods(): readonly ContractMethod[] {
  const methods = getOperatorContract().operator?.methods;
  return Array.isArray(methods) ? (methods as ContractMethod[]) : [];
}

function contractBinding(id: string): { method: string; path: string } | null {
  const found = contractMethods().find((method) => method.id === id);
  const method = found?.http?.method?.toUpperCase();
  const path = found?.http?.path;
  return method && path ? { method, path } : null;
}

/**
 * Written out, deliberately. These twelve are the actions the operator-action
 * tool exposes; if one is removed from the product this list is where that
 * decision has to be made explicitly rather than silently inherited.
 */
const EXPECTED_ACTION_IDS = [
  'approvals.approve',
  'approvals.cancel',
  'approvals.deny',
  'automation.jobs.disable',
  'automation.jobs.enable',
  'automation.jobs.run',
  'automation.runs.cancel',
  'automation.runs.retry',
  'automation.schedules.delete',
  'automation.schedules.disable',
  'automation.schedules.enable',
  'automation.schedules.run',
] as const;

const EXPECTED_BRIEFING_IDS = [
  'approvals.list',
  'automation.integration.snapshot',
  'automation.schedules.list',
  'projectPlanning.workPlan.snapshot',
  'scheduler.capacity',
  'workLedger.project',
  'workLedger.snapshot',
] as const;

describe('operator action bindings', () => {
  test('the product exposes exactly the actions this test knows about', () => {
    expect([...OPERATOR_ACTION_IDS].sort()).toEqual([...EXPECTED_ACTION_IDS]);
  });

  test('every action id is still published by the contract with an HTTP route', () => {
    for (const id of EXPECTED_ACTION_IDS) {
      expect(contractBinding(id), `contract no longer serves ${id}`).not.toBeNull();
    }
  });

  test('every action sends the verb and path the contract publishes', () => {
    for (const id of EXPECTED_ACTION_IDS) {
      const binding = contractBinding(id)!;
      const descriptor = getOperatorActions()[id];
      expect(descriptor.pathTemplate, `${id} path`).toBe(binding.path);
      expect(String(descriptor.httpMethod ?? 'POST'), `${id} verb`).toBe(binding.method);
    }
  });

  test('each action names a target field that appears in its own path template', () => {
    // A target field that is not in the path is a request that silently drops
    // the id, the route resolves, the daemon acts on nothing, and the caller
    // is told it worked. DELETE-with-no-suffix included: the id is still in the
    // path, it is just the last segment.
    for (const id of EXPECTED_ACTION_IDS) {
      const descriptor = getOperatorActions()[id];
      expect(descriptor.pathTemplate, `${id} must interpolate ${descriptor.targetField}`)
        .toContain(`{${descriptor.targetField}}`);
    }
  });
});

describe('operator briefing bindings', () => {
  test('the briefing reads exactly the methods this test knows about', () => {
    expect([...OPERATOR_BRIEFING_METHOD_IDS].sort()).toEqual([...EXPECTED_BRIEFING_IDS]);
  });

  test('every briefing method is still published with an HTTP route', () => {
    for (const id of EXPECTED_BRIEFING_IDS) {
      expect(contractBinding(id), `contract no longer serves ${id}`).not.toBeNull();
    }
  });

  test('the briefing reads the paths the contract publishes', () => {
    for (const route of operatorBriefingRoutes()) {
      expect(route.path, `${route.id} path`).toBe(contractBinding(route.id)!.path);
    }
  });

  test('every briefing method is read-only', () => {
    // The tool's whole promise is that assembling a briefing changes nothing.
    for (const id of EXPECTED_BRIEFING_IDS) {
      expect(contractBinding(id)!.method, `${id} must be a read`).toBe('GET');
    }
  });
});

describe('connected-host capability report', () => {
  test('the operator-read family reports the briefing routes, not a second list', () => {
    const family = connectedHostRouteFamilies().find((entry) => entry['id'] === 'operator-read');
    expect(family).toBeDefined();
    expect(family!['routes']).toEqual(operatorBriefingRoutes().map((route) => route.path));
  });
});
