import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { contractPath } from '../../sdk/src/platform/contract/store.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('dispose freezes resumable snapshots before cancellation, then joins real cleanup without late rewrites', async () => {
  const root = makeRepo();
  roots.push(root);
  const first = makeHarness({ root, plan: oneUnitPlan(1), scripts: {} });
  harnesses.push(first);
  const cleanup = deferred();
  first.manager.setExecutor({ runAgent: async (record) => {
    record.status = 'running';
    const signal = first.manager.getCancellationSignal(record.id)!;
    try {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally { await cleanup.promise; }
  } });
  const { contract } = startContract(first);
  await waitFor(() => first.store.get(contract.id)?.units[0]?.activeAgentId !== undefined, 'a running unit');
  first.runner.dispose();
  const contractFile = contractPath(root, contract.id);
  const itemFile = join(root, '.goodvibes', 'orchestration', contract.id, 'g1.json');
  const contractBefore = readFileSync(contractFile, 'utf-8');
  const itemBefore = readFileSync(itemFile, 'utf-8');
  const snapshot = JSON.parse(contractBefore).contract;
  expect(snapshot.status).toBe('running');
  expect(snapshot.groups[0].status).toBe('running');
  expect(snapshot.units[0].status).toBe('running');
  expect(JSON.parse(itemBefore).workstream.items[0].state).toBe('in-phase');
  let settled = false;
  const barrier = first.runner.join(contract.id).then(() => { settled = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  cleanup.resolve();
  await barrier;
  expect(readFileSync(contractFile, 'utf-8')).toBe(contractBefore);
  expect(readFileSync(itemFile, 'utf-8')).toBe(itemBefore);

  const second = makeHarness({ root, plan: oneUnitPlan(1), scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: 'Completed after restart.' }] } });
  harnesses.push(second);
  await second.runner.resumeAll();
  await waitFor(() => second.store.get(contract.id)?.status === 'passed', 'resumed contract pass');
  await second.runner.join(contract.id);
});
