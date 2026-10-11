/** Successor to the retired main → WRFC review topology. Real native admission,
 * checks, bounded correction, re-review, durable decisions and git integration;
 * only the planner, executor and Jev answers are deterministic fixtures. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashState, toJson } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { contractPath, readContractSnapshot } from '../../sdk/src/platform/contract/store.js';
import { createNativeIntegrationFixture, integrationBarrier } from './native-integration-support.js';
import { draftUnit, plannerOutput, type DraftPlan } from './plan-support.js';
import { waitFor } from './runner-support.js';
import { fixPlan, judgeOf, stepPlanner } from './steps-support.js';

export const REVIEWED_GOAL = 'Repair add() in src/math.ts, review the repair, and integrate it.';
export const REVIEWED_CRITERIA = ['The exported add(a, b) returns a + b.'];
export const REVIEWED_BUGGY = 'export function add(a: number, b: number): number {\n  return a - b;\n}\n';
export const REVIEWED_STILL_BUGGY = '/** Adds two numbers. */\n' + REVIEWED_BUGGY;
export const REVIEWED_FIXED = REVIEWED_STILL_BUGGY.replace('return a - b;', 'return a + b;');

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Reviewed native fixture git operation failed');
  return result.stdout.trim();
}

export async function createNativeReviewedRepairFixture() {
  const plan: DraftPlan = { goal: REVIEWED_GOAL, criteria: REVIEWED_CRITERIA.map((text, i) => ({ id: `c${i + 1}`, text, quote: text })), groups: [
    { id: 'g1', title: 'Repair addition', goal: 'Repair addition', kind: 'work', dependsOn: [], criteria: [], units: [draftUnit('u1', {
      title: 'Repair add()', goal: REVIEWED_CRITERIA[0]!, brief: 'Correct and document src/math.ts.', files: ['src/math.ts'],
      criteria: [{ id: 'u1.c1', text: REVIEWED_CRITERIA[0]!, serves: ['c1'] }],
    })] },
    { id: 'g2', title: 'Verify integration', goal: 'Verify the reviewed addition repair', kind: 'integration', dependsOn: ['g1'], criteria: [], units: [draftUnit('u2', {
      role: 'integration', files: ['src/verified.ts'], criteria: [{ id: 'u2.c1', text: 'The addition repair is integrated.', serves: ['c1'] }],
    })] },
  ] };
  const repair = integrationBarrier(); const tail = integrationBarrier();
  const fixRequests: unknown[] = [];
  const reads: { stateHash: string; fixed: boolean }[] = [];
  const planner = stepPlanner(plan, { fix: () => plannerOutput(fixPlan([{ serves: ['u1.c1'], files: ['src/math.ts'] }])) });
  const f = await createNativeIntegrationFixture({ work: { title: 'Reviewed addition repair', goal: REVIEWED_GOAL, criteria: REVIEWED_CRITERIA },
    harness: { plan, planner: planner.runner, contract: { isolation: 'worktree', stallLimit: 1, maxFixRounds: 1, autoCommit: true, midRunChecks: false },
      scripts: {
        // Deliberately claim success while the file is still wrong. The real
        // diff, not this claim or a predetermined review ordinal, decides.
        u1: () => [1, 2].map(() => ({ files: { 'src/math.ts': REVIEWED_STILL_BUGGY }, text: 'add() returns a + b; review the current source.' })),
        'u1.f1.u1': () => [{ files: { 'src/math.ts': REVIEWED_FIXED }, text: 'Corrected add(); review the current source.' }],
        u2: () => [{ text: 'Waiting to finish integration', tool: true, after: signal => tail.wait(signal) },
          { text: 'The reviewed repair is integrated.', files: { 'src/verified.ts': 'export const reviewed = true;\n' } }],
      },
      port: context => {
        if (judgeOf(context) !== 'unit') return undefined;
        const evidence = context.state['evidence'] as { changedPaths?: unknown; diff?: unknown };
        if (!Array.isArray(evidence.changedPaths) || !evidence.changedPaths.includes('src/math.ts')) return undefined;
        if (typeof evidence.diff !== 'string') throw new Error('Reviewed native check omitted actual file evidence');
        // This is the real evidence collector's diff. A removed buggy line is
        // history, while a current/context or added line is code under review.
        const current = evidence.diff.split('\n').filter(line => !line.startsWith('-')).join('\n');
        const fixed = current.includes('return a + b;') && !current.includes('return a - b;');
        if (context.name === 'criterion_0') {
          const state = toJson(context.state);
          if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Reviewed check state must remain a JSON object');
          reads.push({ stateHash: hashState(state), fixed });
        }
        return noulAnswer(fixed ? 0.03 : 0.9);
      },
    },
    decoratePort: port => ({ ...port, async ask(request) {
      if (request.context?.site === 'contract.native.fix-plan') { fixRequests.push(structuredClone(request.state)); await repair.wait(request.signal); }
      return port.ask(request);
    } }),
  });
  try {
    mkdirSync(join(f.root, 'src'), { recursive: true });
    writeFileSync(join(f.root, 'src/math.ts'), REVIEWED_BUGGY);
    git(f.root, 'add', 'src/math.ts'); git(f.root, 'commit', '-q', '-m', 'Add buggy addition fixture');
  } catch (error) { await f.dispose(); throw error; }
  const commitsBefore = Number(git(f.root, 'rev-list', '--count', 'HEAD'));
  const originalDispose = f.dispose;
  return { ...f, planner, fixRequests, commitsBefore, releaseRepair: repair.release, releaseTail: tail.release,
    async waitForRepair() { await waitFor(() => fixRequests.length > 0, 'native review failure and bounded fix plan', 20_000); },
    async waitForRepaired(contractId: string) { await waitFor(() => f.harness.runner.get(contractId)?.units.find(unit => unit.id === 'u1')?.checks.at(-1)?.trigger === 'fix-passed'
      && f.harness.agentsOf('u2').length > 0, 'real native re-review and integration', 20_000); },
    proof(contractId: string) {
      f.harness.store.flush();
      const parsed = readContractSnapshot(readFileSync(contractPath(f.root, contractId), 'utf8'));
      if ('rejected' in parsed) throw new Error('Reviewed native persisted contract was rejected');
      const contract = parsed.snapshot.contract;
      const unit = contract.units.find(candidate => candidate.id === 'u1');
      if (!unit) throw new Error('Missing reviewed native unit');
      const checks = unit.checks.map(check => ({ id: check.id, trigger: check.trigger, result: check.result, evidenceDigest: check.evidenceDigest,
        // Match the captured real evidence to the persisted answered decision,
        // rather than treating a scripted final message as a successful review.
        sourceRead: reads.find(read => check.decisionIds.some(id => {
          const decision = f.log.get(id); return decision?.status === 'answered' && decision.stateHash === read.stateHash;
        }))?.fixed === true ? 'fixed' : reads.some(read => !read.fixed && check.decisionIds.some(id => f.log.get(id)?.stateHash === read.stateHash)) ? 'buggy' : 'missing',
        answered: check.decisionIds.length > 0 && check.decisionIds.every(id => f.log.get(id)?.status === 'answered'),
      }));
      const decisions = contract.nativeDecisions?.history.filter(record => record.stage === 'stall' || record.stage === 'fix-plan').map(record => ({
        stage: record.stage, outcome: record.decision.outcome,
        sourceBound: record.decision.binding.sourceId === contract.nativeSource?.sourceId,
        answered: record.decision.judgmentDecisionIds.length > 0 && record.decision.judgmentDecisionIds.every(id => f.log.get(id)?.status === 'answered'),
      })) ?? [];
      return { checks, decisions, fixRounds: unit.fixRounds, fixWorkers: f.harness.agentsOf('u1.f1.u1').length,
        fixPlans: planner.of('fix').length, escalations: contract.escalations.length, status: contract.status,
        commit: contract.commit ?? null, goal: contract.goal, criteria: contract.criteria.map(criterion => criterion.text),
        sourceGoal: contract.nativeSource?.goal, sourceCriteria: contract.nativeSource?.criteria };
    },
    async dispose() { repair.release(); tail.release(); await originalDispose(); },
  };
}
