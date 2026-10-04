import { afterEach, expect, test } from 'bun:test';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { Contract, DurableContractRequest, NativeContractSource } from '../../sdk/src/platform/contract/index.js';
import { DurableContractAdmissions } from '../../sdk/src/platform/contract/durable-admission.js';
import { getContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { makeHarness, makeRepo, oneUnitPlan, waitFor, type Harness, type HarnessOptions } from './runner-support.js';
import { plannerOutput } from './plan-support.js';
import { finishes, terminal } from './steps-support.js';

const roots: string[] = []; const harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) { const ids = h.runner.list({ includeTerminal: true }).map(c => c.id); h.dispose(); await Promise.all(ids.map(id => h.runner.join(id))); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source: NativeContractSource = { sourceId: 'original', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Preserve the original parser', criteria: ['Preserve parser behavior'] };
const authority = { authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' };
function plan() { return { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] }; }
function setup(options: Partial<HarnessOptions> = {}) { const root = options.root ?? makeRepo(); if (!roots.includes(root)) roots.push(root); const h = makeHarness({ root, recordNative: true, nativeDecisions: { authorityOf: () => authority }, durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) }, plan: plan(), scripts: {}, ...options }); harnesses.push(h); return h; }
function request(root: string, isolation: 'auto' | 'worktree' | 'shared' | undefined = 'worktree'): DurableContractRequest { return { key: { workId: 'work', criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt' }, binding: { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'start', actionRevision: '1', ...authority }, input: { ask: 'Display only', nativeSource: source, sessionId: 'isolation', origin: 'turn', projectRoot: root, ...(isolation === undefined ? {} : { isolation }) } }; }
async function stop(h: Harness, id: string) { h.dispose(); await h.runner.join(id); harnesses.splice(harnesses.indexOf(h), 1); }

test.each(['isolation', 'branch', 'worktreePath', 'baseBranch', 'sessionMode'] as const)('durable resume refuses changed resolved %s before planning', async field => {
  const first = setup({ contract: { maxActiveContracts: 0 } }); const submitted = request(first.root);
  const started = await first.runner.startDurable(submitted); await stop(first, started.admission.contractId);
  const admissions = new DurableContractAdmissions(first.root); const admission = admissions.read(submitted.key)!;
  const snapshot = JSON.parse(admissions.checkpoint(submitted.key)) as { contract: Contract };
  if (field === 'sessionMode') snapshot.contract.sessionMode = true;
  else if (field === 'isolation') snapshot.contract.isolation = 'shared';
  else snapshot.contract[field] = 'changed-placement';
  admissions.update(admission, JSON.stringify(snapshot));
  let planners = 0; const second = setup({ root: first.root, planner: { run: async () => { planners++; return { status: 'completed', output: plannerOutput(plan()), elapsedMs: 1 }; } } });
  await expect(second.runner.resumeDurable(submitted.key)).rejects.toThrow('checkpoint'); expect(planners).toBe(0); expect(second.manager.list()).toHaveLength(0);
});

test.each(['invalid', null, 0, [], ['shared'], {}].map(value => ({ value })))('invalid isolation %j fails before any owner record exists', async ({ value: invalid }) => {
  const h = setup(); const submitted = request(h.root); const changed = { ...submitted, input: { ...submitted.input, isolation: invalid } } as unknown as DurableContractRequest;
  await expect(h.runner.startDurable(changed)).rejects.toThrow('invalid'); expect(h.manager.list()).toHaveLength(0);
});

test.each(['auto', undefined, 'shared'] as const)('resolved placement for %s is not recomputed from later configuration', async isolation => {
  const first = setup({ contract: { maxActiveContracts: 0, isolation: 'worktree' } }); const submitted = request(first.root, isolation);
  const started = await first.runner.startDurable(submitted); expect(started.admission.schemaVersion).toBe(2);
  expect(started.admission.execution?.isolation).toBe(isolation === 'shared' ? 'shared' : 'worktree'); await stop(first, started.admission.contractId);
  let workingDir = ''; let bound = false;
  const second = setup({ root: first.root, contract: { isolation: isolation === 'shared' ? 'worktree' : 'shared' }, scripts: { u1: finishes('complete parser') },
    planner: { run: async input => { workingDir = input.workingDir; bound = getContractInputAuthority(input) !== undefined; return { status: 'completed', output: plannerOutput(plan()), elapsedMs: 1 }; } } });
  await second.runner.resumeDurable(submitted.key); await waitFor(() => terminal(second, started.admission.contractId), 'resolved placement result'); await second.runner.join(started.admission.contractId);
  expect(second.store.get(started.admission.contractId)?.status).toBe('passed'); expect(bound).toBe(isolation !== 'shared');
  if (isolation === 'shared') expect(workingDir).toBe(first.root); else expect(workingDir).not.toBe(first.root);
}, 20_000);

test('reentrant placement mutation at launch is refused before planning', async () => {
  let planners = 0;
  const h = setup({ planner: { run: async () => { planners++; return { status: 'completed', output: plannerOutput(plan()), elapsedMs: 1 }; } },
    durableAdmission: { withCurrent: (admission, launch) => { h.store.get(admission.contractId)!.isolation = 'shared'; launch(() => undefined); } } });
  await expect(h.runner.startDurable(request(h.root))).rejects.toThrow('checkpoint'); expect(planners).toBe(0); expect(h.agentsOf('u1')).toHaveLength(0);
});

test('recorded no-delegation still enters session mode without spawning a member', async () => {
  const h = setup({ port: context => context.name === 'forbids_delegation' ? noulAnswer(0.99) : undefined });
  const started = await h.runner.startDurable(request(h.root, 'auto'));
  await waitFor(() => h.store.get(started.admission.contractId)?.status === 'running' || terminal(h, started.admission.contractId), 'native session mode');
  expect(h.store.get(started.admission.contractId)).toMatchObject({ status: 'running', sessionMode: true, isolation: 'shared' });
  expect(h.agentsOf('u1')).toHaveLength(0); expect(started.admission.execution?.isolation).toBe('worktree');
});

test('historical v1 receipt replays for inspection but cannot infer resolved placement for resume', async () => {
  const first = setup({ contract: { maxActiveContracts: 0 } }); const submitted = request(first.root, 'auto');
  const started = await first.runner.startDurable(submitted); await stop(first, started.admission.contractId);
  const admissions = new DurableContractAdmissions(first.root); const admission = admissions.read(submitted.key)!;
  const checkpoint = JSON.parse(admissions.checkpoint(submitted.key)) as { contract: Contract };
  const directory = join(first.root, '.goodvibes', 'contracts', 'admissions');
  const files = (await import('node:fs')).readdirSync(directory).filter(name => name.endsWith('.json')); expect(files).toHaveLength(1);
  const path = join(directory, files[0]!); const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const { execution: _execution, ...old } = admission; const legacy = { ...old, schemaVersion: 1 as const };
  envelope.admission = legacy; checkpoint.contract = { ...checkpoint.contract, durableAdmission: legacy }; envelope.checkpoint = JSON.stringify(checkpoint); writeFileSync(path, JSON.stringify(envelope));
  const second = setup({ root: first.root }); expect((await second.runner.startDurable(submitted)).admission.contractId).toBe(started.admission.contractId);
  await expect(second.runner.resumeDurable(submitted.key)).rejects.toThrow('checkpoint'); expect(second.manager.list()).toHaveLength(0);
});
