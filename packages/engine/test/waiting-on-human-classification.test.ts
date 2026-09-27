/**
 * waiting-on-human-classification.test.ts
 *
 * ONE waiting-on-human state class: an approval ask, a best-of-N pick the
 * owner is asked to make, and any other decision a contract waits on its owner
 * for classify as first-class attention in the fleet snapshot; every reason
 * fans out as FLEET_NODE_BLOCKED_ON_USER on the wire (via the emit-bridge) and
 * pushes through the same needs-input source, so every surface inherits glyph,
 * count, jump key, and push from the classification.
 */
import { describe, expect, test } from 'bun:test';
import { adaptContract, adaptContractUnit } from '../sdk/src/platform/runtime/fleet/adapters/contract.ts';
import { deriveNeedsAttention } from '../sdk/src/platform/runtime/fleet/adapters/agent.ts';
import { attachFleetEmitBridge } from '../sdk/src/platform/runtime/fleet/emit-bridge.ts';
import type { FleetSnapshot, ProcessNode } from '../sdk/src/platform/runtime/fleet/types.ts';
import { PushService } from '../sdk/src/platform/push/index.ts';
import type { FleetNotice, PushMessage, PushSubscriptionStore, VapidManager } from '../sdk/src/platform/push/index.ts';
import type { Contract, ContractView, Escalation } from '../sdk/src/platform/contract/types.ts';
import { makeContract, makeUnit } from './contract/fixtures.ts';
import type { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { EventEmitter } from 'node:events';
import { trackDisposables } from './_helpers/disposables.ts';
import { cancellableEscalationScheduler } from './_helpers/push-escalation.ts';

const disposables = trackDisposables();

const T0 = 1_750_000_000_000;

function escalation(overrides: Partial<Escalation> & Pick<Escalation, 'id' | 'scope' | 'targetId' | 'reason'>): Escalation {
  return { at: T0, question: 'Contract ctr-1 needs your decision.\nMore detail.', unmetCriterionIds: [], ...overrides };
}

function unitNode(contract: Contract, unitId: string) {
  const unit = [...contract.units, ...contract.units.flatMap((candidate) => candidate.attemptUnits ?? [])].find((candidate) => candidate.id === unitId)!;
  return adaptContractUnit(unit, contract as ContractView, { memberNodes: [], messageBusPresent: false, now: T0 });
}

describe('snapshot classification: every reason a contract waits on its owner is first-class', () => {
  test('approval: awaiting-approval derives the approval attention (unchanged)', () => {
    expect(deriveNeedsAttention('awaiting-approval')).toEqual({ reason: 'approval' });
  });

  test('an undecided best-of-N selection flags the plan unit with reason "pick" and marks its attempts ready', () => {
    const attempt0 = makeUnit({ id: 'u1#a0', status: 'held-merge', attemptOf: 'u1', attemptIndex: 0 });
    const attempt1 = makeUnit({ id: 'u1#a1', status: 'failed', attemptOf: 'u1', attemptIndex: 1 });
    const contract = makeContract({
      id: 'ctr-1', status: 'awaiting-owner', createdAt: T0,
      units: [makeUnit({ id: 'u1', attempts: 2, status: 'awaiting-owner', attemptUnits: [attempt0, attempt1] })],
      escalations: [escalation({ id: 'e1', scope: 'unit', targetId: 'u1', reason: 'attempts-undecided' })],
    });
    const plan = unitNode(contract, 'u1');
    expect(plan.needsAttention).toEqual({ reason: 'pick', detail: 'Contract ctr-1 needs your decision.' });
    expect(plan.state).toBe('idle'); // parked on the owner, not done
    const held = unitNode(contract, 'u1#a0');
    expect(held.parentId).toBe('unit:ctr-1:u1');
    expect(held.attemptGroup).toEqual({ groupId: 'u1', index: 0, total: 2, held: true, ready: true });
    // One decision over the attempts: the flag rides the plan unit only.
    expect(held.needsAttention).toBeUndefined();
    expect(unitNode(contract, 'u1#a1').attemptGroup).toMatchObject({ held: false, ready: true });
  });

  test('attempts with no open selection escalation are not ready and do not flag', () => {
    const contract = makeContract({
      id: 'ctr-2', createdAt: T0,
      units: [makeUnit({ id: 'u1', attempts: 2, status: 'running', attemptUnits: [
        makeUnit({ id: 'u1#a0', status: 'held-merge', attemptOf: 'u1', attemptIndex: 0 }),
        makeUnit({ id: 'u1#a1', status: 'running', attemptOf: 'u1', attemptIndex: 1 }),
      ] })],
    });
    expect(unitNode(contract, 'u1').needsAttention).toBeUndefined();
    expect(unitNode(contract, 'u1#a0').attemptGroup?.ready).toBe(false);
  });

  test('a plan, deliverable or unit escalation flags its own node with reason "input"; a resolved one does not', () => {
    const contract = makeContract({
      id: 'ctr-3', status: 'awaiting-owner', createdAt: T0,
      units: [makeUnit({ id: 'u1', status: 'awaiting-owner' })],
      escalations: [
        escalation({ id: 'e1', scope: 'deliverable', targetId: 'ctr-3', reason: 'stalled' }),
        escalation({ id: 'e2', scope: 'unit', targetId: 'u1', reason: 'unsettled' }),
      ],
    });
    expect(adaptContract(contract as ContractView, [], T0).needsAttention).toMatchObject({ reason: 'input' });
    expect(unitNode(contract, 'u1').needsAttention).toMatchObject({ reason: 'input' });
    contract.escalations = contract.escalations.map((open) => ({ ...open, resolvedAt: T0 + 1 }));
    expect(adaptContract(contract as ContractView, [], T0).needsAttention).toBeUndefined();
    expect(unitNode(contract, 'u1').needsAttention).toBeUndefined();
  });
});

describe('wire events: all three reasons emit FLEET_NODE_BLOCKED_ON_USER', () => {
  function nodeWith(id: string, reason: 'approval' | 'input' | 'pick' | 'conflict' | undefined, state: ProcessNode['state']): ProcessNode {
    return {
      id, kind: 'contract-unit', label: id, state, elapsedMs: 0, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
      ...(reason ? { needsAttention: { reason } } : {}),
    } as ProcessNode;
  }

  test('approval, pick, and conflict all cross the wire with their own reason', () => {
    let listener: ((s: FleetSnapshot) => void) | null = null;
    const registry = { subscribe: (l: (s: FleetSnapshot) => void) => { listener = l; return () => {}; } };
    const ee = new EventEmitter();
    const events: Array<{ type: string; reason?: string; nodeId?: string }> = [];
    ee.on('fleet', (envelope: { payload: { type: string; reason?: string; nodeId?: string } }) => events.push(envelope.payload));
    const bus = { emit: ee.emit.bind(ee) } as unknown as RuntimeEventBus;
    attachFleetEmitBridge({ registry, bus, traceId: () => 't' });

    // Seed with no attention…
    listener!({ capturedAt: T0, nodes: [nodeWith('n-appr', undefined, 'thinking'), nodeWith('n-pick', undefined, 'paused'), nodeWith('n-conf', undefined, 'executing-tool')] });
    // …then all three become waiting-on-human.
    listener!({ capturedAt: T0 + 1, nodes: [nodeWith('n-appr', 'approval', 'awaiting-approval'), nodeWith('n-pick', 'pick', 'paused'), nodeWith('n-conf', 'conflict', 'stalled')] });

    const blocked = events.filter((e) => e.type === 'FLEET_NODE_BLOCKED_ON_USER');
    expect(blocked.map((e) => [e.nodeId, e.reason]).sort()).toEqual([
      ['n-appr', 'approval'], ['n-conf', 'conflict'], ['n-pick', 'pick'],
    ]);
  });
});

describe('push: a ready pick and a conflict both push through the needs-input source', () => {
  function makeService(): { service: PushService; delivered: PushMessage[] } {
    const service = new PushService({
      vapid: {} as VapidManager,
      store: {} as PushSubscriptionStore,
      scheduler: cancellableEscalationScheduler(disposables),
    });
    const delivered: PushMessage[] = [];
    (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m) => { delivered.push(m); return []; };
    return { service, delivered };
  }

  test('pick and conflict notices fan out as pushes with honest wording', async () => {
    const { service, delivered } = makeService();
    let listener: ((n: FleetNotice) => void) | null = null;
    service.attachFleetNeedsInputSource({ subscribe: (l) => { listener = l; return () => {}; } });

    listener!({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'ws-node', label: 'checkout flow', reason: 'pick', sessionId: 's1' });
    listener!({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'item-node', label: 'payment refactor', reason: 'conflict', sessionId: 's1' });
    await Promise.resolve();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.body).toBe('checkout flow has a best-of-N pick ready for you.');
    expect(delivered[1]?.body).toBe('payment refactor has a merge conflict waiting on you.');
    expect(delivered.every((m) => m.urgency === 'high')).toBe(true);
  });
});
