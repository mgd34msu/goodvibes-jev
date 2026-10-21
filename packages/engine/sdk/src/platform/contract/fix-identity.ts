import type { Contract, ContractGroup, ContractUnit } from './types.js';

/** Retry budgets can reset after an amendment; retained work identities cannot. */
export function allocateFixIdentity(group: ContractGroup, units: readonly ContractUnit[], reserved: ReadonlySet<string>): { group: ContractGroup; units: ContractUnit[] } {
  if (![group.id, ...units.map(unit => unit.id), ...units.flatMap(unit => unit.criteria.map(criterion => criterion.id))].some(id => reserved.has(id))) return { group, units: [...units] };
  if (group.kind !== 'fix' || !group.repairs) throw new Error('A colliding group is not a repair group');
  if (group.status !== 'pending' || group.checks.length || group.baseline || units.some(unit => unit.status !== 'pending'
    || unit.agentIds.length || unit.activeAgentId || unit.checks.length || unit.baseline || unit.nudges.length || unit.touchedPaths.length
    || unit.lastOutput || unit.answer || unit.readEvidence?.length || unit.commandEvidence?.length)) {
    throw new Error('A colliding repair already has execution evidence; its identity cannot be changed');
  }
  const prefix = `${group.repairs.targetId}.f`;
  if (!group.id.startsWith(prefix) || !/^[1-9]\d*$/.test(group.id.slice(prefix.length))
    || units.some(unit => !unit.id.startsWith(group.id + '.u') || unit.criteria.some(criterion => !criterion.id.startsWith(unit.id + '.c')))
    || group.unitIds.some(id => !units.some(unit => unit.id === id))) throw new Error('Colliding repair identities have an unrecognized shape');
  let ordinal = 1;
  while ([...reserved].some(id => id === `${prefix}${ordinal}` || id.startsWith(`${prefix}${ordinal}.`))) ordinal++;
  const old = group.id, next = `${prefix}${ordinal}`;
  const ids = new Map(units.map(unit => [unit.id, next + unit.id.slice(old.length)]));
  return { group: { ...group, id: next, unitIds: group.unitIds.map(id => ids.get(id)!) },
    units: units.map(unit => ({ ...unit, id: ids.get(unit.id)!, groupId: next,
      dependsOn: unit.dependsOn.map(id => ids.get(id) ?? id),
      criteria: unit.criteria.map(criterion => ({ ...criterion, id: ids.get(unit.id)! + criterion.id.slice(unit.id.length) })),
    })) };
}

/** Recover only unstarted legacy duplicates. Accepted records stay byte-for-byte
 * intact; no execution or approval is transferred to the renamed work. */
export function recoverPendingFixIdentities(contract: Contract): void {
  if (new Set(contract.groups.map(group => group.id)).size === contract.groups.length
    && new Set(contract.units.map(unit => unit.id)).size === contract.units.length) return;
  const available = new Map<string, ContractUnit[]>();
  for (const unit of contract.units) {
    const list = available.get(unit.id) ?? []; list.push(unit); available.set(unit.id, list);
  }
  const reserved = new Set([...contract.groups.map(group => group.id), ...contract.units.flatMap(unit => [unit.id, ...unit.criteria.map(criterion => criterion.id)])]);
  const seen = new Set<string>();
  for (let index = 0; index < contract.groups.length; index++) {
    let group = contract.groups[index]!;
    const units = group.unitIds.map(id => available.get(id)?.shift());
    if (units.some(unit => unit === undefined || unit.groupId !== group.id)) throw new Error('Colliding repair membership is ambiguous');
    let members = units as ContractUnit[];
    if ([group.id, ...members.map(unit => unit.id)].some(id => seen.has(id))) {
      if (contract.nativeSource !== undefined) throw new Error('A native contract cannot migrate colliding legacy work identities');
      const previous = group.id;
      const allocated = allocateFixIdentity(group, members, reserved);
      for (let member = 0; member < members.length; member++) contract.units[contract.units.indexOf(members[member]!)] = allocated.units[member]!;
      contract.groups[index] = allocated.group;
      group = allocated.group;
      members = allocated.units;
      contract.decisions.push({ id: `${contract.id}.d${contract.decisions.length + 1}`, at: Date.now(), action: 'created', targetId: group.id, decisionIds: [],
        reason: `Recovered unstarted repair identity ${previous} as ${group.id}; retained accepted work and retry budgets are unchanged. No execution or acceptance was inferred.` });
    }
    for (const id of [group.id, ...members.flatMap(unit => [unit.id, ...unit.criteria.map(criterion => criterion.id)])]) { seen.add(id); reserved.add(id); }
  }
}

/** Find the scheduled attempt from actual host records, rather than deriving
 * its identity from a retry budget that an owner amendment can reset. */
export function hasScheduledFix(contract: Pick<Contract, 'groups' | 'decisions'>, targetId: string, round: number): boolean {
  if (contract.groups.some(group => group.repairs?.targetId === targetId && ['pending', 'running', 'judging', 'fixing'].includes(group.status))) return true;
  const amendment = contract.decisions.findLastIndex(decision => decision.targetId === targetId
    && decision.action === 'owner-replied' && decision.reason.startsWith('amended as the owner instructed:'));
  const scheduled = contract.decisions.findLastIndex(decision => decision.targetId === targetId
    && decision.action === 'fix-planned' && decision.reason.startsWith(`round ${round}: group `));
  if (scheduled > amendment) {
    const groupId = /^round \d+: group (\S+) with /.exec(contract.decisions[scheduled]!.reason)?.[1];
    if (groupId) return contract.groups.some(group => group.id === groupId);
  }
  return amendment < 0 && contract.groups.some(group => group.id === `${targetId}.f${round}`);
}
