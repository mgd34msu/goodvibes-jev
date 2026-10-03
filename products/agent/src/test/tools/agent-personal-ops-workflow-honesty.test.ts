/**
 * Workflow-readiness honesty tests.
 *
 * The dogfood defect class: personal-ops lane/workflow cards computed
 * "ready" from methodIds.length > 0, counting operator-contract methods
 * that are advertised but NOT dispatchable (invokable:false, the email.*
 * methods were marked so after proving no daemon route serves them). A lane
 * card must
 * never claim readiness backed only by methods a caller cannot invoke.
 *
 * These tests run against the REAL operator contract (the vendored
 * @goodvibes-jev/engine/sdk contract, which carries
 * email.*: invokable:false), plus pure-function checks that hold no matter
 * which method families are marked unavailable later (calendar.* is being
 * marked by a parallel fix, the generic invokable filter must degrade it
 * automatically with no further agent change).
 */
import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import {
  calendarWorkflows,
  inboxWorkflows,
  isInvokableContractMethod,
  methodIdsMatching,
  unavailableMethodIdsMatching,
  unavailableMethodsNote,
  workflowStatus,
} from '../../tools/agent-harness-personal-ops-discovery.ts';
import type { OperatorContractMethod } from '../../tools/agent-harness-personal-ops-types.ts';

const EMAIL_TOKENS = ['email', 'mail', 'imap', 'smtp'] as const;
const CALENDAR_TOKENS = ['calendar', 'caldav', 'agenda'] as const;

function contractMethods(): readonly OperatorContractMethod[] {
  const contract = getOperatorContract();
  return (contract.operator?.methods ?? []) as unknown as readonly OperatorContractMethod[];
}

describe('isInvokableContractMethod', () => {
  test('false only for explicit invokable:false; absent flag means invokable', () => {
    expect(isInvokableContractMethod({ id: 'a' })).toBe(true);
    expect(isInvokableContractMethod({ id: 'a', invokable: true })).toBe(true);
    expect(isInvokableContractMethod({ id: 'a', invokable: false })).toBe(false);
  });
});

describe('methodIdsMatching excludes advertised-but-undispatchable methods', () => {
  test('every id returned for email tokens is invokable in the real contract', () => {
    const byId = new Map(contractMethods().map((m) => [m.id, m]));
    for (const id of methodIdsMatching([...EMAIL_TOKENS])) {
      const method = byId.get(id);
      expect(method).toBeDefined();
      expect(isInvokableContractMethod(method!)).toBe(true);
    }
  });

  test('email tokens: any method marked invokable:false is excluded from readiness automatically', () => {
    // These four WERE the reason this test exists: email.send and the inbox
    // reads were cataloged with no daemon route behind them. The IMAP/SMTP
    // service is platform capability now and the daemon attaches a real
    // handler to each id, so the contract carries none of them as
    // invokable:false any more. Asserting the INVARIANT rather than the count
    // is what keeps this honest in both directions, it fails if a route-less
    // method ever creeps back into readiness, and it does not fail merely
    // because the routes got built.
    const readinessIds = new Set(methodIdsMatching([...EMAIL_TOKENS]));
    const unavailableIds = unavailableMethodIdsMatching([...EMAIL_TOKENS]);
    const byId = new Map(contractMethods().map((m) => [m.id, m]));
    for (const id of unavailableIds) {
      expect(readinessIds.has(id)).toBe(false);
      expect(byId.get(id)?.invokable).toBe(false);
    }
  });

  test('the four email methods the daemon now serves are counted toward readiness', () => {
    // The positive half: a fixed route has to actually show up as capability,
    // or the hoist bought nothing a person can see.
    const readinessIds = new Set(methodIdsMatching([...EMAIL_TOKENS]));
    for (const id of ['email.inbox.list', 'email.inbox.read', 'email.send', 'email.draft.create']) {
      expect(readinessIds.has(id), `${id} is served by the daemon now`).toBe(true);
    }
  });

  test('calendar tokens: any method marked invokable:false is excluded from readiness automatically', () => {
    // calendar.* may still be invokable:true in this contract snapshot (the
    // parallel fixer is marking them SDK-side). This asserts the INVARIANT
    // either way: readiness ids and unavailable ids are disjoint, and every
    // unavailable id really carries invokable:false.
    const readinessIds = new Set(methodIdsMatching([...CALENDAR_TOKENS]));
    const unavailableIds = unavailableMethodIdsMatching([...CALENDAR_TOKENS]);
    const byId = new Map(contractMethods().map((m) => [m.id, m]));
    for (const id of unavailableIds) {
      expect(readinessIds.has(id)).toBe(false);
      expect(byId.get(id)?.invokable).toBe(false);
    }
  });
});

describe('workflowStatus honesty', () => {
  test('unavailable-only advertisements do not make a workflow ready', () => {
    // methodIdsMatching now returns [] when only non-invokable methods match,
    // so the status computation sees an empty list -> needs-setup.
    expect(workflowStatus([], [])).toBe('needs-setup');
  });

  test('a genuinely dispatchable method still yields ready', () => {
    expect(workflowStatus(['tasks.list'], [])).toBe('ready');
  });
});

describe('degraded-ad wording (matches the route-not-served pattern)', () => {
  test('unavailableMethodsNote names the methods and the route-not-served reason', () => {
    const note = unavailableMethodsNote(['email.inbox.list', 'email.send']);
    expect(note).toContain('unavailable (route not served by this daemon)');
    expect(note).toContain('email.inbox.list');
    expect(note).toContain('email.send');
    expect(unavailableMethodsNote([])).toBeNull();
  });

  test('inboxWorkflows in needs-setup state carries the degraded-ad note in prerequisites', () => {
    const workflows = inboxWorkflows([], [], ['email.inbox.list', 'email.send']);
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      expect(workflow.status).toBe('needs-setup');
      expect(workflow.prerequisites.join('\n')).toContain('unavailable (route not served by this daemon)');
    }
  });

  test('calendarWorkflows in needs-setup state carries the degraded-ad note in prerequisites', () => {
    const workflows = calendarWorkflows([], [], ['calendar.events.list']);
    for (const workflow of workflows) {
      expect(workflow.status).toBe('needs-setup');
      expect(workflow.prerequisites.join('\n')).toContain('unavailable (route not served by this daemon)');
    }
  });

  test('no degraded-ad note when nothing is unavailable', () => {
    const workflows = inboxWorkflows([], [], []);
    for (const workflow of workflows) {
      expect(workflow.prerequisites.join('\n')).not.toContain('route not served');
    }
  });
});
