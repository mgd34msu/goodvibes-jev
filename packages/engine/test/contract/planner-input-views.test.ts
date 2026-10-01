/** Exercise the actual criteria-amendment and planned-fix planner entry points. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { buildAmendmentPrompt, buildFixPlannerPrompt } from '../../sdk/src/platform/contract/index.js';
import { contractInputPath } from '../../sdk/src/platform/contract/input-snapshot.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { plannerOutput } from './plan-support.js';
import { MET, amendmentOutput, answers, finishes, fixPlan, fixedOutputsMeet, judgeOf, keepsFailing, replyAnswers, routeAnswer, stepPlanner, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; });

for (const mode of ['normal', 'stale', 'stale-check', 'cancel'] as const) {
  test(`planned-fix sees produced work in a frozen descendant view (${mode})`, async () => {
    const plan = oneUnitPlan(1);
    const scripted = stepPlanner(plan, { fix: () => plannerOutput(fixPlan([{ serves: ['u1.c1'], files: ['src/csv.ts'] }])) });
    let view = ''; let originalId = ''; let fixCalls = 0;
    const h = harness = makeHarness({ plan, contract: { isolation: 'worktree', stallLimit: 2 },
      scripts: { u1: keepsFailing(3), 'u1.f1.u1': finishes('fixed the parser') },
      port: answers((context) => {
        if (mode === 'stale-check' && fixCalls > 0 && context.name === 'role') writeFileSync(join(h.store.list()[0]!.worktreePath!, 'src/csv.ts'), 'contract changed during plan checking\n');
        return undefined;
      }, fixedOutputsMeet, routeAnswer('split')),
      planner: { async run(request) {
        if (request.systemPrompt === buildFixPlannerPrompt()) {
          fixCalls++; view = request.workingDir;
          const contract = h.store.list()[0]!; originalId = contract.inputSnapshot!.id;
          expect(view).not.toBe(contract.worktreePath); expect(view).not.toBe(h.root);
          expect(readFileSync(join(view, 'src/csv.ts'), 'utf8')).toBe('attempt 2\n');
          expect(readFileSync(join(view, 'README.md'), 'utf8')).toBe('# demo\n');
          if (mode === 'stale') {
            writeFileSync(join(contract.worktreePath!, 'src/csv.ts'), 'concurrent contract writer\n');
            expect(readFileSync(join(view, 'src/csv.ts'), 'utf8')).toBe('attempt 2\n');
          }
          if (mode === 'cancel') h.runner.cancel(contract.id, 'cancel corrective planning');
        } else {
          writeFileSync(join(h.root, 'README.md'), 'later owner edit\n');
        }
        return scripted.runner.run(request);
      } },
    });
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'corrective planning result', 20_000);
    const done = h.store.get(contract.id)!;
    expect(fixCalls).toBe(1); expect(done.inputSnapshot!.id).toBe(originalId); expect(existsSync(view)).toBe(true);
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('later owner edit\n');
    const receiptDir = join(h.root, '.goodvibes/contracts/planner-input');
    const receipts = readdirSync(receiptDir); expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(receiptDir, receipts[0]!), 'utf8')) as { originalInputId: string; workingDirectory: string; snapshot: { sourceRoot: string } };
    expect(receipt.originalInputId).toBe(originalId); expect(receipt.workingDirectory).toBe(view); expect(receipt.snapshot.sourceRoot).toBe(done.worktreePath!);
    if (mode === 'normal') { expect(done.status).toBe('passed'); expect(done.units.find((unit) => unit.id === 'u1.f1.u1')?.status).toBe('passed'); }
    else {
      expect(done.status).toBe(mode === 'cancel' ? 'cancelled' : 'failed'); expect(h.agentsOf('u1.f1.u1')).toEqual([]);
      if (mode === 'stale' || mode === 'stale-check') expect(done.error).toContain('contract result changed during fix planning');
    }
  }, 25_000);
}

test('criteria amendment keeps original grounding while applying the owner\'s new criteria and brief', async () => {
  const plan = oneUnitPlan(1); let amended = false; let calls = 0;
  const scripted = stepPlanner(plan, { amend: () => { amended = true; return amendmentOutput([{ id: 'u1.c1', text: 'Owner supplied semicolon criterion' }], 'Owner supplied revised brief'); } });
  const h = harness = makeHarness({ plan, contract: { isolation: 'worktree', stallLimit: 2 }, scripts: { u1: keepsFailing(3) },
    port: answers((context) => amended && judgeOf(context) !== null ? noulAnswer(MET) : undefined, routeAnswer('owner'), replyAnswers([{ reading: 'amend' }])),
    planner: { async run(request) {
      if (request.systemPrompt === buildAmendmentPrompt()) {
        calls++;
        expect(request.workingDir).toBe(contractInputPath(h.store.list()[0]!.inputSnapshot!));
        expect(readFileSync(join(request.workingDir, 'README.md'), 'utf8')).toBe('# demo\n');
        expect(request.userPrompt).toContain('Require the semicolon criterion and revised brief');
      }
      return scripted.runner.run(request);
    } },
  });
  const { contract } = startContract(h);
  await waitFor(() => h.store.get(contract.id)?.status === 'awaiting-owner' || terminal(h, contract.id), 'criteria escalation', 15_000);
  const pending = h.store.get(contract.id)!; expect(pending.status).toBe('awaiting-owner');
  const receipt = structuredClone(pending.inputSnapshot!);
  writeFileSync(join(h.root, 'README.md'), 'later owner edit\n');
  const outcome = await h.runner.reply(contract.id, pending.escalations.at(-1)!.id, 'Require the semicolon criterion and revised brief');
  expect(outcome.action).toBe('amended');
  await waitFor(() => terminal(h, contract.id), 'amended result', 15_000);
  const done = h.store.get(contract.id)!;
  expect(calls).toBe(1); expect(done.status).toBe('passed'); expect(done.inputSnapshot).toEqual(receipt);
  expect(done.units[0]!.criteria.some((criterion) => criterion.origin === 'owner' && criterion.text === 'Owner supplied semicolon criterion')).toBe(true);
  expect(done.units[0]!.brief).toBe('Owner supplied revised brief');
  expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('later owner edit\n');
}, 25_000);
