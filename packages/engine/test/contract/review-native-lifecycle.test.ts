import { expect, test } from 'bun:test';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { makeHarness, oneUnitPlan, startContract, waitFor } from './runner-support.js';
import { finishes, terminal } from './steps-support.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';

const source: NativeContractSource = { sourceId: 'review-work', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'review-criteria', criteriaRevision: '1', goal: 'Deliver the original parser', criteria: ['Preserve all parser behavior'] };
function plan() { return { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] }; }

test('review: authority change during semantic defer cancels pending operation rather than recapturing new authority', async () => {
  let authorityRevision = '1'; let evidenceRevision = '1'; let wake: (() => void) | undefined; let planDecisions = 0;
  const h = makeHarness({ recordNative: true, plan: plan(), scripts: { u1: finishes('complete parser') },
    nativeDecisions: {
      authorityOf: () => ({ authorityId: 'actor', authorityRevision, scopeId: 'project', scopeRevision: '1' }),
      conditions: (_contract, stage) => stage === 'plan' ? [{ ref: { id: 'ready', revision: evidenceRevision }, description: 'External build evidence arrives', current: () => ({ id: 'ready', revision: evidenceRevision }),
        wait: signal => new Promise<void>((resolve, reject) => { wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }] : [],
    },
    port: context => context.name === 'disposition' && String((context.state['binding'] as { actionId?: string })?.actionId).includes(':plan:')
      ? choiceAnswer(context.question, planDecisions++ === 0 ? 'defer_0' : 'act', 0.99) : undefined,
  });
  try {
    const id = startContract(h, { nativeSource: source }).contract.id;
    await waitFor(() => wake !== undefined, 'registered semantic condition wait');
    authorityRevision = 'revoked'; evidenceRevision = '2'; wake!();
    await waitFor(() => terminal(h, id), 'terminal native contract', 15000); await h.runner.join(id);
    console.log('REVIEW_RESULT', JSON.stringify({ status: h.store.get(id)?.status, agents: h.agentsOf('u1').length, receipts: h.store.get(id)?.nativeDecisions?.history.map(r => ({ stage: r.stage, outcome: r.decision.outcome, authorityRevision: r.decision.binding.authorityRevision })) }));
    expect(h.store.get(id)?.status).toBe('cancelled');
    expect(h.agentsOf('u1')).toHaveLength(0);
  } finally { h.dispose(); }
}, 20000);
