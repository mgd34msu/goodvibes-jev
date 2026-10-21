import type { ContractView } from './types.js';

/** Actual checked research with non-artifact observations, not old delivery drafts. */
export function acceptedResearchIds(contract: Pick<ContractView, 'units'>,
  artifactPaths = new Set(contract.units.flatMap(unit => unit.touchedPaths))): ReadonlySet<string> {
  return new Set(contract.units.filter(unit => {
    const check = unit.checks.at(-1);
    return unit.role === 'research' && unit.status === 'passed' && check?.result === 'pass'
      && check.decisionIds.length > 0
      && unit.readEvidence?.some(read => read.contentKind !== 'declared-reference' && !artifactPaths.has(read.path));
  }).map(unit => unit.id));
}
