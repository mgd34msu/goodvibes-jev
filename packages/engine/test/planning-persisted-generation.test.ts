import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-persisted-generation-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const first = new KnowledgeStore({ dbPath: path });
  const firstService = new ProjectPlanningService(first);
  await firstService.upsertState({ projectId: 'fixture', state: { goal: 'Original goal', executionApproved: false, tasks: [{ id: 'original', title: 'Original work' }] } });
  const selected = await firstService.getState({ projectId: 'fixture' });
  const second = new KnowledgeStore({ dbPath: path }); await second.init();
  const secondService = new ProjectPlanningService(second);
  return { path, first, second, firstService, secondService, selected };
}
async function reopen(path: string) {
  const store = new KnowledgeStore({ dbPath: path }); await store.init();
  return { store, state: await new ProjectPlanningService(store).getState({ projectId: 'fixture' }) };
}

test('a stale planning handle cannot approve over another handle’s persisted replacement', async () => {
  const f = await fixture();
  await f.secondService.upsertState({ projectId: 'fixture', state: { ...f.selected.state!, goal: 'Second owner replacement', tasks: [{ id: 'second', title: 'Second owner work' }] } });
  const before = readFileSync(f.path);
  const result = await f.firstService.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision: f.selected.revision! }, action: { kind: 'approve' } });
  const third = await reopen(f.path);
  expect({ applied: result.applied, goal: third.state.state!.goal, approved: third.state.state!.executionApproved }).toEqual({ applied: false, goal: 'Second owner replacement', approved: false });
  expect(readFileSync(f.path)).toEqual(before);
});

test('two independently loaded handles cannot both create an absent conditional source', async () => {
  const f = await fixture();
  const source = { id: 'conditional', connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const };
  const results = await Promise.all([
    f.first.upsertSourceIfCurrent({ ...source, metadata: { owner: 'first' } }, null),
    f.second.upsertSourceIfCurrent({ ...source, metadata: { owner: 'second' } }, null),
  ]);
  const third = await reopen(f.path);
  expect({ kinds: results.map(result => result.kind).sort(), owner: third.store.getSource(source.id)?.metadata.owner }).toEqual({ kinds: ['held', 'written'], owner: 'first' });
});

test('a guarded source update preserves another handle’s writes to other tables', async () => {
  const f = await fixture();
  await f.second.upsertJobRun({ id: 'other-owner-job', jobId: 'fixture-job', status: 'completed', mode: 'inline', result: { retained: true } });
  const result = await f.firstService.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision: f.selected.revision! }, action: { kind: 'approve' } });
  const third = await reopen(f.path);
  expect(result.applied).toBe(true);
  expect(third.store.getJobRun('other-owner-job')).toMatchObject({ status: 'completed', result: { retained: true } });
  expect(f.first.getJobRun('other-owner-job')).toMatchObject({ status: 'completed' });
});

test('a conditional action holds rather than reloading over pending local batch writes', async () => {
  const f = await fixture();
  await f.first.batch(async () => {
    await f.first.upsertJobRun({ id: 'local-pending-job', jobId: 'fixture-job', status: 'completed', mode: 'inline' });
    const result = await f.firstService.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision: f.selected.revision! }, action: { kind: 'approve' } });
    expect(result.applied).toBe(false);
  });
  const third = await reopen(f.path);
  expect(third.store.getJobRun('local-pending-job')).toMatchObject({ status: 'completed' });
  expect(third.state.state!.executionApproved).toBe(false);
});

test('separate processes released from one barrier cannot both win an expected-null creation', async () => {
  const f = await fixture();
  const script = `
    import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
    const store = new KnowledgeStore({ dbPath: process.argv[1] });
    await store.init();
    console.log('ready');
    await Bun.stdin.text();
    const result = await store.upsertSourceIfCurrent({ id: 'process-conditional', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { owner: process.argv[2] } }, null);
    console.log(JSON.stringify({ owner: process.argv[2], kind: result.kind }));
  `;
  const children = ['first', 'second'].map(owner => Bun.spawn([
    process.execPath, '--no-env-file', '--preload', new URL('../scripts/test-network-preload.ts', import.meta.url).pathname,
    '-e', script, f.path, owner,
  ], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  const readers = children.map(child => child.stdout.getReader());
  const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill(); }, 12000);
  try {
    await Promise.all(readers.map(async reader => {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('ready');
    }));
    for (const child of children) { child.stdin.write('go'); child.stdin.end(); }
    const results = await Promise.all(children.map(async (child, index) => {
      const output = async () => { let text = ''; for (;;) { const chunk = await readers[index]!.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value); } };
      const [exit, text, error] = await Promise.all([child.exited, output(), new Response(child.stderr).text()]);
      expect({ exit, error }).toEqual({ exit: 0, error: '' });
      return JSON.parse(text.trim()) as { owner: string; kind: 'written' | 'held' };
    }));
    const third = await reopen(f.path);
    expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
    expect(third.store.getSource('process-conditional')?.metadata.owner).toBe(results.find(result => result.kind === 'written')!.owner);
  } finally {
    clearTimeout(deadline);
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map(child => child.exited));
    for (const reader of readers) reader.releaseLock();
  }
}, 20000);
