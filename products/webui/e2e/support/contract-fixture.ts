/** Stateful, synthetic contract reads. No runner, provider or mutation is used. */
import type { Page, Route } from '@playwright/test';
import type { OperatorMethodOutput } from '../../src/lib/goodvibes';
import { installMockDaemon, type MockDaemonOptions } from './mock-daemon';

export type ContractFixture = OperatorMethodOutput<'contracts.get'>;
const AT = Date.UTC(2026, 9, 5, 8);
const USAGE: ContractFixture['usage'] = {
  inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
  llmCallCount: 1, turnCount: 1, toolCallCount: 1, costUsd: null, costState: 'unpriced',
};

export const CONTRACT_EVIDENCE_DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;
export const CONTRACT_CHECK: ContractFixture['checks'][number] = {
  id: 'ctr-a1000001.k2', at: AT + 2000, trigger: 'completion',
  claims: { kind: 'files_verified', summary: 'Browser proof is attached to the checked commit.' },
  gates: [
    { gate: 'typecheck', passed: true, output: 'Types passed with no diagnostics.', durationMs: 125 },
    { gate: 'browser', passed: false, output: 'Phone detail overflow remains unresolved.', durationMs: 400 },
    { gate: 'publish', passed: false, skipped: true, output: 'Publishing was outside the requested scope.', durationMs: 0 },
  ],
  goal: { probabilityUnmet: 0.81, verdict: 'unmet', outcome: 'escalate' },
  quality: { hidden_failure: { verdict: 'no', outcome: 'act' } },
  result: 'await-owner', problems: ['gate', 'unmet'], decisionIds: ['decision-goal-2'],
  evidenceDigest: CONTRACT_EVIDENCE_DIGEST,
};

export const WAITING_CONTRACT: ContractFixture = {
  id: 'ctr-a1000001', schemaVersion: 5, sessionId: 's-contract-proof', origin: 'turn',
  ask: 'Make the phone contract inspector usable without changing any running work.',
  ownerAgentId: 'agent-contract-owner', projectRoot: '/workspace/browser-proof', isolation: 'shared',
  goal: 'Inspect the release contract', status: 'awaiting-owner', createdAt: AT,
  criteria: [
    {
      id: 'criterion-phone', text: 'The detail fits the phone viewport.', origin: 'stated',
      quote: 'usable on my phone', serves: [], disposition: 'judged', status: 'unmet',
      readings: [
        { checkId: 'ctr-a1000001.k1', at: AT + 1000, probabilityUnmet: 0.32, verdict: 'unshown', outcome: 'confirm', decisionId: 'decision-phone-1' },
        { checkId: CONTRACT_CHECK.id, at: AT + 2000, probabilityUnmet: 0.81, verdict: 'unmet', outcome: 'escalate', severity: 'major', decisionId: 'decision-phone-2', severityDecisionId: 'decision-severity-2' },
      ],
    },
    { id: 'criterion-read-only', text: 'Inspection cannot alter contract state.', origin: 'derived', serves: ['criterion-phone'], disposition: 'met-by-structure', dispositionReason: 'Only read endpoints are exposed.', status: 'met', readings: [] },
    { id: 'criterion-deploy', text: 'Deployment is excluded from this inspection.', origin: 'owner', serves: [], disposition: 'excluded', dispositionReason: 'The owner requested local inspection only.', status: 'unread', readings: [] },
  ],
  groups: [{
    id: 'g-inspect', title: 'Read-only inspection group', goal: 'Show recorded verification evidence.', kind: 'work',
    dependsOn: [], criteria: [], unitIds: ['u-phone'], status: 'awaiting-owner',
    checks: [{ ...CONTRACT_CHECK, id: 'g-inspect.k1', evidenceDigest: 'group-evidence-001' }], fixRounds: 1, usage: USAGE,
  }],
  units: [{
    id: 'u-phone', groupId: 'g-inspect', title: 'Phone inspection unit', goal: 'Keep long evidence within the viewport.',
    brief: 'Render the full digest and preserve every recorded reading.', role: 'implement', dependsOn: [],
    files: ['products/webui/src/views/work/ContractDetail.tsx'], attempts: 1,
    criteria: [{ id: 'criterion-unit', text: 'Evidence digests remain readable.', origin: 'derived', serves: ['criterion-phone'], disposition: 'judged', status: 'unshown', readings: [] }],
    status: 'awaiting-owner', agentIds: ['agent-phone'], checks: [{ ...CONTRACT_CHECK, id: 'u-phone.k1', evidenceDigest: 'unit-evidence-001' }],
    nudges: [], fixRounds: 1, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage: USAGE,
    lastOutput: 'A synthetic browser observation is awaiting review.',
  }],
  checks: [CONTRACT_CHECK], fixRounds: 1,
  escalations: [
    { id: 'esc-resolved', at: AT + 1200, scope: 'plan', targetId: 'ctr-a1000001', reason: 'plan-unresolved', question: 'Should the check include desktop?', unmetCriterionIds: [], resolvedAt: AT + 1500, reply: { text: 'Include desktop as well as phone.', reading: 'amend', outcome: 'act', decisionId: 'decision-owner-1' } },
    { id: 'esc-open', at: AT + 2100, scope: 'unit', targetId: 'u-phone', reason: 'owner-decision-needed', question: 'Can the phone overflow be accepted for this release?', unmetCriterionIds: ['criterion-phone'], decisionIds: ['decision-phone-2'] },
  ],
  decisions: [{ id: 'decision-record-1', at: AT + 2100, action: 'escalated', targetId: 'u-phone', reason: 'Phone verification needs the owner.', decisionIds: ['decision-phone-2'] }],
  usage: USAGE, judgmentUsage: { calls: 2, inputTokens: 30, outputTokens: 10 }, plannerAgentIds: [],
};

export const RUNNING_CONTRACT: ContractFixture = {
  ...WAITING_CONTRACT, id: 'ctr-a1000002', goal: 'Inspect the integration contract',
  ask: 'Verify integration separately from the release.', status: 'running',
  criteria: [], groups: [], units: [], checks: [], escalations: [], decisions: [], fixRounds: 0,
};

export const PASSED_CONTRACT: ContractFixture = {
  ...RUNNING_CONTRACT, id: 'ctr-a1000003', goal: 'Completed contract proof', status: 'passed',
  completedAt: AT + 3000, answer: 'The read-only contract inspection passed all checks.',
  statusLine: 'All recorded criteria were met.',
  commit: { status: 'skipped', note: 'Inspection did not write a commit.' },
};

export const FAILED_CONTRACT: ContractFixture = {
  ...RUNNING_CONTRACT, id: 'ctr-a1000004', goal: 'Failed contract proof', status: 'failed',
  completedAt: AT + 3100, error: 'The synthetic verification could not finish.',
};

export const CANCELLED_CONTRACT: ContractFixture = {
  ...RUNNING_CONTRACT, id: 'ctr-a1000005', goal: 'Cancelled contract proof', status: 'cancelled',
  completedAt: AT + 3200, statusLine: 'The owner stopped this synthetic contract.',
};

export const CONTRACT_FIXTURES = [WAITING_CONTRACT, RUNNING_CONTRACT, PASSED_CONTRACT, FAILED_CONTRACT, CANCELLED_CONTRACT] as const;
export const isTerminalFixture = (contract: ContractFixture): boolean => ['passed', 'failed', 'cancelled'].includes(contract.status);

export interface ContractDaemonOptions extends MockDaemonOptions {
  contracts?: readonly ContractFixture[];
  listError?: { status: number; error: string; code?: string };
}

/**
 * Wrap the ordinary mock; only the two read paths and the contracts-domain
 * invalidation stream change. Held details capture the OLD response, allowing
 * real late-response tests without timing sleeps or a synthetic UI event.
 */
export async function installContractDaemon(page: Page, options: ContractDaemonOptions = {}) {
  const daemon = await installMockDaemon(page, options);
  let contracts: ContractFixture[] = structuredClone([...(options.contracts ?? CONTRACT_FIXTURES)]);
  let listError = options.listError;
  const detailErrors = new Map<string, { status: number; error: string; code?: string }>();
  const heldDetails = new Set<string>();
  const pendingDetails = new Map<string, { route: Route; body: ContractFixture | undefined }[]>();
  const streams: Route[] = [];

  async function sendDetail(route: Route, body: ContractFixture | undefined) {
    await route.fulfill(body ? { json: body } : { status: 404, json: { error: 'Contract not found.', code: 'CONTRACT_NOT_FOUND' } });
  }

  await page.route('**/api/contracts**', async (route) => {
    const url = new URL(route.request().url());
    // Writes deliberately fail even if a regression accidentally renders one.
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only contract fixture.' } });
    if (url.pathname === '/api/contracts') {
      if (listError) return route.fulfill({ status: listError.status, json: listError });
      const includeTerminal = url.searchParams.get('includeTerminal') === 'true';
      return route.fulfill({ json: { contracts: contracts.filter((contract) => includeTerminal || !isTerminalFixture(contract)) } });
    }
    const match = /^\/api\/contracts\/([^/]+)$/.exec(url.pathname);
    if (!match) return route.fulfill({ status: 404, json: { error: 'Unknown contract read.' } });
    const id = decodeURIComponent(match[1]);
    const error = detailErrors.get(id);
    if (error) return route.fulfill({ status: error.status, json: error });
    const body = structuredClone(contracts.find((contract) => contract.id === id));
    if (heldDetails.has(id)) {
      pendingDetails.set(id, [...(pendingDetails.get(id) ?? []), { route, body }]);
      return;
    }
    return sendDetail(route, body);
  });

  await page.route('**/api/control-plane/events**', async (route) => {
    const domains = new URL(route.request().url()).searchParams.get('domains')?.split(',') ?? [];
    if (!domains.includes('contracts')) return route.fallback();
    streams.push(route);
  });

  return {
    ...daemon,
    get streamCount() { return streams.length; },
    get contracts() { return contracts; },
    setContracts(next: readonly ContractFixture[]) { contracts = structuredClone([...next]); },
    setListError(error: typeof listError) { listError = error; },
    setDetailError(id: string, error: { status: number; error: string; code?: string } | undefined) {
      if (error) detailErrors.set(id, error); else detailErrors.delete(id);
    },
    holdDetail(id: string) { heldDetails.add(id); },
    pendingDetailCount(id: string) { return pendingDetails.get(id)?.length ?? 0; },
    async releaseDetail(id: string) {
      heldDetails.delete(id);
      const pending = pendingDetails.get(id) ?? [];
      pendingDetails.delete(id);
      await Promise.all(pending.map(({ route, body }) => sendDetail(route, body)));
    },
    async emitContractChange(id: string, from: ContractFixture['status'], to: ContractFixture['status']) {
      const body = `event: contracts\ndata: ${JSON.stringify({ payload: { type: 'CONTRACT_STATUS_CHANGED', contractId: id, from, to } })}\n\n`;
      await Promise.all(streams.splice(0).map((route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body })));
    },
  };
}
