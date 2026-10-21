import { expect, test } from 'bun:test';
import { allocateFixIdentity, hasScheduledFix } from '../../sdk/src/platform/contract/fix-identity.js';
import { deserializeContract, serializeContract } from '../../sdk/src/platform/contract/store.js';
import { makeContract, makeGroup, makeUnit } from './fixtures.js';

function fixture() {
  const groupId = 'ctr-12345678.f1';
  const units = [1, 2].map(number => makeUnit({ id: `${groupId}.u${number}`, groupId, status: 'pending',
    dependsOn: number === 1 ? [] : [`${groupId}.u1`],
    criteria: [{ id: `${groupId}.u${number}.c1`, text: 'Complete the remaining work', origin: 'fix',
      serves: ['c1'], disposition: 'judged', status: 'unread', readings: [] }],
  }));
  const group = makeGroup({ id: groupId, kind: 'fix', status: 'pending', unitIds: units.map(unit => unit.id),
    repairs: { scope: 'deliverable', targetId: 'ctr-12345678', criterionIds: ['c1'] } });
  return { group, units };
}

test('a reset repair budget allocates unused group, unit and criterion identities', () => {
  const f = fixture(); const before = JSON.stringify(f);
  const next = allocateFixIdentity(f.group, f.units, new Set([f.group.id, 'ctr-12345678.f2.u1']));
  expect(next.group.id).toBe('ctr-12345678.f3');
  expect(next.group.unitIds).toEqual(['ctr-12345678.f3.u1', 'ctr-12345678.f3.u2']);
  expect(next.units[1]).toMatchObject({ id: 'ctr-12345678.f3.u2', groupId: next.group.id,
    dependsOn: ['ctr-12345678.f3.u1'], criteria: [{ id: 'ctr-12345678.f3.u2.c1', serves: ['c1'], status: 'unread' }] });
  expect(next.group.fixRounds).toBe(0);
  expect(JSON.stringify(f)).toBe(before);
});

test('loading an old unstarted collision preserves accepted work and resumes only renamed pending work', () => {
  const old = fixture(), fresh = fixture(); old.group.status = 'passed';
  for (const unit of old.units) { unit.status = 'passed'; unit.answer = 'Accepted earlier work'; }
  const accepted = JSON.stringify(old);
  const contract = makeContract({ id: 'ctr-12345678', status: 'fixing', fixRounds: 1,
    groups: [old.group, fresh.group], units: [...old.units, ...fresh.units] });
  const restored = deserializeContract(serializeContract(contract, 1)!)!;
  expect(JSON.stringify({ group: restored.groups[0], units: restored.units.slice(0, 2) })).toBe(accepted);
  expect(restored.groups[1]!.id).toBe('ctr-12345678.f2');
  expect(restored.units[3]!.dependsOn).toEqual(['ctr-12345678.f2.u1']);
  expect(restored.units.slice(2).every(unit => unit.status === 'pending' && unit.checks.length === 0 && unit.agentIds.length === 0)).toBe(true);
  expect(restored.fixRounds).toBe(1);
  expect(restored.decisions.at(-1)!.reason).toContain('No execution or acceptance was inferred.');
  expect(deserializeContract(serializeContract(restored, 2)!)).toEqual(restored);
});

test('a collision with execution evidence is held rather than relabeling observations or approvals', () => {
  const f = fixture(); f.units[0]!.agentIds.push('already-started');
  expect(() => allocateFixIdentity(f.group, f.units, new Set([f.group.id]))).toThrow('already has execution evidence');
});

test('an older accepted attempt cannot hide interrupted repair planning after an amendment', () => {
  const f = fixture(); f.group.status = 'passed';
  const contract = makeContract({ groups: [f.group], decisions: [
    { id: 'd1', at: 1, action: 'fix-planned', targetId: 'ctr-12345678', reason: 'round 1: group ctr-12345678.f1 with 2 units', decisionIds: [] },
    { id: 'd2', at: 2, action: 'owner-replied', targetId: 'ctr-12345678', reason: 'amended as the owner instructed: added o1', decisionIds: [] },
  ] });
  expect(hasScheduledFix(contract, 'ctr-12345678', 1)).toBe(false);
  const next = allocateFixIdentity(fixture().group, fixture().units, new Set([f.group.id]));
  contract.groups.push(next.group);
  expect(hasScheduledFix(contract, 'ctr-12345678', 1)).toBe(true);
  next.group.status = 'passed';
  contract.decisions.push({ id: 'd3', at: 3, action: 'fix-planned', targetId: 'ctr-12345678',
    reason: 'round 1: group ctr-12345678.f2 with 2 units', decisionIds: [] });
  expect(hasScheduledFix(contract, 'ctr-12345678', 1)).toBe(true);
  expect(hasScheduledFix(contract, 'ctr-12345678', 2)).toBe(false);
});
