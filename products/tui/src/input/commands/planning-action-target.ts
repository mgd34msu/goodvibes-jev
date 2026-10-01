import type { ProjectPlanningRevision, ProjectPlanningStateExpectation } from '@goodvibes-jev/engine/sdk/platform/knowledge';

/** Internal command transport for a selection made from one persisted view. */
export function selectedPlanningTarget(planningId: string, revision: ProjectPlanningRevision): string[] {
  return ['--selected-revision', planningId, revision.sourceId, revision.generation];
}

export type PlanningActionTarget =
  | { readonly valid: false }
  | { readonly valid: true; readonly expected: ProjectPlanningStateExpectation; readonly planningId?: string; readonly selected: boolean; readonly args: readonly string[] };

/** A malformed selected binding must never fall back to the manual current mode. */
export function parsePlanningActionTarget(args: readonly string[]): PlanningActionTarget {
  if (args[0] !== '--selected-revision') {
    return { valid: true, expected: Object.freeze({ kind: 'current' }), selected: false, args: [...args] };
  }
  const [, planningId, sourceId, generation] = args;
  if (!planningId || !sourceId || !generation || !/^[a-f0-9]{64}$/.test(generation)) return { valid: false };
  const revision = Object.freeze({ sourceId, generation });
  return { valid: true, expected: Object.freeze({ kind: 'revision', revision }), planningId, selected: true, args: args.slice(4) };
}
