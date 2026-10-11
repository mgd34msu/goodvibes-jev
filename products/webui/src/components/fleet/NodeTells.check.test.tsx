import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createProcessRegistry, type ProcessRegistryDeps } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { CURRENT_CONTRACT_SCHEMA_VERSION, type ContractView, type Criterion } from '@goodvibes-jev/engine/sdk/platform/contract';
import { emptyWorkItemUsage } from '@goodvibes-jev/engine/sdk/platform/orchestration';
import { NodeReviewSummary } from './NodeTells';
import type { FleetProcessNode } from '../../lib/goodvibes';

function contract(): ContractView {
  const criterion = (id: string, status: Criterion['status']): Criterion => ({
    id, text: `Requirement ${id}`, origin: 'stated', quote: `Requirement ${id}`, serves: [], disposition: 'judged', status,
    readings: status === 'unread' ? [] : [{ checkId: 'check-1', at: 2000, probabilityUnmet: status === 'met' ? 0.001 : 0.999,
      verdict: status, outcome: 'act', decisionId: `decision-${id}`, ...(status === 'unmet' ? { severity: 'major' as const } : {}) }],
  });
  return {
    id: 'contract-fixture', schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, sessionId: 'session-fixture', origin: 'cli',
    ask: 'Complete the fixture requirements.', ownerAgentId: 'owner', projectRoot: '/fixture', isolation: 'shared', goal: 'Fixture goal',
    criteria: [], groups: [{ id: 'g1', title: 'Fixture group', goal: 'Fixture group goal', kind: 'work', dependsOn: [], criteria: [],
      unitIds: ['u1'], status: 'running', checks: [], fixRounds: 0, usage: emptyWorkItemUsage() }],
    units: [{ id: 'u1', groupId: 'g1', title: 'Fixture unit', goal: 'Complete unit', brief: 'Read the fixture.', role: 'implement',
      dependsOn: [], files: [], attempts: 1, criteria: [criterion('met-one', 'met'), criterion('unmet-one', 'unmet'), criterion('unread-one', 'unread')],
      status: 'nudged', agentIds: [],
      checks: [{ id: 'check-1', at: 2000, trigger: 'completion', goal: { probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act' },
        quality: {}, result: 'nudge', decisionIds: [], evidenceDigest: 'fixture-digest' }],
      nudges: [{ id: 'nudge-1', checkId: 'check-1', at: 2001, kinds: ['unmet'], criterionIds: ['unmet-one'], text: 'Address the criterion', delivery: 'hold', agentId: 'owner' }],
      fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage: emptyWorkItemUsage() }],
    status: 'running', checks: [], fixRounds: 0, escalations: [], decisions: [], usage: emptyWorkItemUsage(),
    judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plannerAgentIds: [], createdAt: 1000,
  };
}
function registryDeps(): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false }, contractRunner: { list: () => [contract()], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: { workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false } }, now: () => 3000,
  };
}
function render(node: FleetProcessNode) {
  const element = document.createElement('div'); const root = createRoot(element);
  flushSync(() => root.render(<NodeReviewSummary node={node} />));
  return { element, close: () => flushSync(() => root.unmount()) };
}
function realUnitNode(): FleetProcessNode {
  const registry = createProcessRegistry(registryDeps());
  try {
    // Uses the actual registry -> adaptContractUnit -> deriveCheckSummary production path and JSON wire boundary.
    const node = registry.getNode('unit:contract-fixture:u1'); expect(node).toBeDefined();
    return JSON.parse(JSON.stringify(node)) as FleetProcessNode;
  } finally { registry.dispose(); }
}
test('real contract adapter check projection is visible in the Fleet detail renderer', () => {
  const node = realUnitNode(); expect(node).not.toHaveProperty('review');
  const view = render(node); try {
    expect(view.element.textContent).toContain('1 of 3 criteria met'); expect(view.element.textContent).toContain('1 correction');
    expect(view.element.querySelectorAll('[data-verdict]')).toHaveLength(3);
    expect(view.element.querySelector('[data-verdict="met"]')?.textContent).toContain('Requirement met-one');
    expect(view.element.querySelector('[data-verdict="unmet"]')?.textContent).toContain('Severity: major');
    expect(view.element.querySelector('[data-verdict="unread"]')?.textContent).toContain('Requirement unread-one');
    expect(view.element.textContent).not.toContain('Accepted'); expect(view.element.textContent).not.toContain('score');
  } finally { view.close(); }
});
test('malformed canonical checks are held instead of falling back to a legacy accepted review', () => {
  const node = realUnitNode();
  const view = render({ ...node, check: { criteria: [], met: 10, judged: 0, nudges: 0 },
    review: { score: 10, passed: true, cycles: 1, checklist: [{ item: 'Legacy evidence', verified: true }] } });
  try { expect(view.element.textContent).toContain('Contract check summary unavailable'); expect(view.element.textContent).not.toContain('Legacy evidence'); expect(view.element.textContent).not.toContain('Accepted'); }
  finally { view.close(); }
});
test('legacy-only review retains its existing renderer when no canonical check is present', () => {
  const { check: _check, ...node } = realUnitNode();
  const view = render({ ...node, review: { score: 8, passed: true, cycles: 2, checklist: [{ item: 'Legacy verified requirement', verified: true, evidence: 'Legacy evidence' }] } });
  try { expect(view.element.textContent).toContain('Accepted'); expect(view.element.textContent).toContain('Legacy verified requirement'); expect(view.element.textContent).toContain('Legacy evidence'); }
  finally { view.close(); }
});
