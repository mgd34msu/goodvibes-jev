/**
 * The fleet operator verbs over contracts (docs/design/contract-runner.md 8.3):
 * `fleet.graph.get`, `fleet.attempts.*` and `fleet.conflicts.*` read and act
 * through the runner, which holds one orchestration engine per contract.
 *
 * Every contract names its groups `g1`, `g2`... and its units `u1`, `u2`...,
 * so a workstream id and a work-item id mean nothing across contracts. The
 * verbs therefore see contract-qualified ids, `<contractId>:<id>`: workstream
 * ids (a contract's group), work-item ids (a unit or an attempt), and
 * best-of-N group ids. An id without a contract part, or naming a contract
 * that is not running, is refused.
 *
 * A pick of a contract attempt goes through `acceptAttempt` by way of the
 * escalation step, which closes the unit's `attempts-undecided` escalation, so
 * the unit takes the attempt exactly as an owner's pick would.
 */
import { AttemptError } from '../orchestration/attempts.js';
import type { WorkstreamGraphSnapshot } from '../orchestration/graph-dynamics.js';
import type { AttemptCandidate, AttemptJudgment, AttemptPickResult, HeldMergeGroup, WorkItem } from '../orchestration/types.js';
import type { ContractRun } from './run-context.js';

/** The conflicted-item slice the conflicts verbs read. */
export interface ContractConflictItem {
  readonly id: string;
  readonly title: string;
  readonly mergeState?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly worktreeBranch?: string | undefined;
  readonly conflictFiles?: readonly string[] | undefined;
  readonly conflictSessionId?: string | undefined;
}

/** The controller the fleet verbs take (control-plane/routes/fleet.ts `FleetAttemptsController`, structurally). */
export interface ContractFleetControls {
  listHeldMergeGroups(workstreamId?: string): Promise<HeldMergeGroup[]>;
  getGraphSnapshot(workstreamId: string): WorkstreamGraphSnapshot | null;
  pickAttemptWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  proposeAttemptWinner(groupId: string): Promise<AttemptJudgment>;
  listWorkstreams(): ReadonlyArray<{ readonly id: string; readonly items: readonly ContractConflictItem[] }>;
  stampConflictSession(itemId: string, sessionId: string): boolean;
  retryItemIntegration(itemId: string): Promise<'merged' | 'conflict' | 'not-conflicted'>;
}

export interface ContractFleetControlsDeps {
  /** The running contracts. */
  readonly runs: () => Iterable<ContractRun>;
  /** The escalation step that takes an operator's pick. */
  readonly operatorPick: (run: ContractRun, unitId: string, attemptId: string) => Promise<void>;
}

const SEPARATOR = ':';

/** `<contractId>:<id>`. */
export function qualifyId(contractId: string, id: string): string {
  return `${contractId}${SEPARATOR}${id}`;
}

/** The contract and the engine-local id of a qualified id, or null when it is not qualified. */
export function splitQualifiedId(qualified: string): { readonly contractId: string; readonly id: string } | null {
  const at = qualified.indexOf(SEPARATOR);
  if (at <= 0 || at === qualified.length - 1) return null;
  return { contractId: qualified.slice(0, at), id: qualified.slice(at + 1) };
}

function qualifyCandidate(contractId: string, candidate: AttemptCandidate): AttemptCandidate {
  return { ...candidate, itemId: qualifyId(contractId, candidate.itemId) };
}

function qualifyJudgment(contractId: string, judgment: AttemptJudgment): AttemptJudgment {
  return {
    ...judgment,
    proposedWinnerItemId: judgment.proposedWinnerItemId === null ? null : qualifyId(contractId, judgment.proposedWinnerItemId),
  };
}

function qualifyGroup(contractId: string, group: HeldMergeGroup): HeldMergeGroup {
  return {
    ...group,
    groupId: qualifyId(contractId, group.groupId),
    workstreamId: qualifyId(contractId, group.workstreamId),
    candidates: group.candidates.map((candidate) => qualifyCandidate(contractId, candidate)),
    judgment: group.judgment === null ? null : qualifyJudgment(contractId, group.judgment),
  };
}

function conflictItem(contractId: string, item: WorkItem): ContractConflictItem {
  return {
    id: qualifyId(contractId, item.id),
    title: item.title,
    ...(item.mergeState === undefined ? {} : { mergeState: item.mergeState }),
    ...(item.worktreePath === undefined ? {} : { worktreePath: item.worktreePath }),
    ...(item.worktreeBranch === undefined ? {} : { worktreeBranch: item.worktreeBranch }),
    ...(item.conflictFiles === undefined ? {} : { conflictFiles: item.conflictFiles }),
    ...(item.conflictSessionId === undefined ? {} : { conflictSessionId: item.conflictSessionId }),
  };
}

export function createContractFleetControls(deps: ContractFleetControlsDeps): ContractFleetControls {
  function runOf(contractId: string): ContractRun | undefined {
    for (const run of deps.runs()) if (run.id === contractId && !run.terminal) return run;
    return undefined;
  }

  /** The running contract and engine an id names; throws an AttemptError (a refused precondition) when there is none. */
  function resolve(qualified: string, what: string): { readonly run: ContractRun; readonly id: string; readonly engine: NonNullable<ContractRun['engine']> } {
    const split = splitQualifiedId(qualified);
    if (split === null) throw new AttemptError(`${what} ${qualified} does not name a contract; use <contractId>:<id>`);
    const run = runOf(split.contractId);
    if (run === undefined || run.engine === null) throw new AttemptError(`contract ${split.contractId} is not running work`);
    return { run, id: split.id, engine: run.engine };
  }

  function lookup(qualified: string): { readonly run: ContractRun; readonly id: string; readonly engine: NonNullable<ContractRun['engine']> } | null {
    const split = splitQualifiedId(qualified);
    const run = split === null ? undefined : runOf(split.contractId);
    return split === null || run === undefined || run.engine === null ? null : { run, id: split.id, engine: run.engine };
  }

  return {
    async listHeldMergeGroups(workstreamId) {
      if (workstreamId !== undefined) {
        const found = lookup(workstreamId);
        if (found === null) return [];
        return (await found.engine.listHeldMergeGroups(found.id)).map((group) => qualifyGroup(found.run.id, group));
      }
      const groups: HeldMergeGroup[] = [];
      for (const run of deps.runs()) {
        if (run.terminal || run.engine === null) continue;
        for (const group of await run.engine.listHeldMergeGroups()) groups.push(qualifyGroup(run.id, group));
      }
      return groups;
    },

    getGraphSnapshot(workstreamId) {
      const found = lookup(workstreamId);
      const snapshot = found?.engine.getGraphSnapshot(found.id) ?? null;
      if (found === null || snapshot === null) return null;
      const contractId = found.run.id;
      return {
        ...snapshot,
        workstreamId: qualifyId(contractId, snapshot.workstreamId),
        nodes: snapshot.nodes.map((node) => ({ ...node, id: qualifyId(contractId, node.id) })),
        edges: snapshot.edges.map((edge) => ({ ...edge, from: qualifyId(contractId, edge.from), to: qualifyId(contractId, edge.to) })),
      };
    },

    async pickAttemptWinner(groupId, winnerItemId) {
      const { run, id: engineGroupId } = resolve(groupId, 'attempt group');
      const winner = splitQualifiedId(winnerItemId);
      if (winner === null || winner.contractId !== run.id) throw new AttemptError(`item ${winnerItemId} is not an attempt of contract ${run.id}`);
      const unit = run.contract.units.find((candidate) => candidate.attemptSelection?.engineGroupId === engineGroupId);
      const selection = unit?.attemptSelection;
      if (unit === undefined || selection === undefined) throw new AttemptError(`attempt group ${groupId} has no selection to pick from yet`);
      if (selection.pickedId !== undefined) throw new AttemptError(`unit ${unit.id} already took attempt ${selection.pickedId}`);
      if (!selection.candidateIds.includes(winner.id)) {
        throw new AttemptError(`${winner.id} is not a passing attempt of unit ${unit.id}; the candidates are ${selection.candidateIds.join(', ')}`);
      }
      await deps.operatorPick(run, unit.id, winner.id);
      return {
        groupId,
        winnerItemId,
        loserItemIds: selection.candidateIds.filter((candidate) => candidate !== winner.id).map((candidate) => qualifyId(run.id, candidate)),
        auto: false,
      };
    },

    async proposeAttemptWinner(groupId) {
      const { run, id, engine } = resolve(groupId, 'attempt group');
      return qualifyJudgment(run.id, await engine.proposeAttemptWinner(id));
    },

    listWorkstreams() {
      const workstreams: { readonly id: string; readonly items: readonly ContractConflictItem[] }[] = [];
      for (const run of deps.runs()) {
        if (run.terminal || run.engine === null) continue;
        for (const workstream of run.engine.listWorkstreams()) {
          workstreams.push({ id: qualifyId(run.id, workstream.id), items: workstream.items.map((item) => conflictItem(run.id, item)) });
        }
      }
      return workstreams;
    },

    stampConflictSession(itemId, sessionId) {
      const found = lookup(itemId);
      return found === null ? false : found.engine.stampConflictSession(found.id, sessionId);
    },

    async retryItemIntegration(itemId) {
      const found = lookup(itemId);
      return found === null ? 'not-conflicted' : found.engine.retryItemIntegration(found.id);
    },
  };
}
