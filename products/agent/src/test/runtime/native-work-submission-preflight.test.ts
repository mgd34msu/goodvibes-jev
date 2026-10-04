import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWorkSubmissionPreflight } from '../../runtime/native-work-submission-preflight.ts';
import { createNativeWorkLedgerView } from '../../runtime/native-work-ledger-host.ts';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('single-flight covers preflight before source IO; close aborts and discards late results', async () => {
  const wait = gate(); let actions = 0; let invalidations = 0;
  const guard = new NativeWorkSubmissionPreflight(() => 'same', () => { invalidations++; });
  const first = guard.run(async signal => { actions++; await wait.promise; expect(signal.aborted).toBe(true); return { status: 'submitted', message: 'late' }; });
  expect((await guard.run(async () => { actions++; return undefined; }))?.status).toBe('pending');
  expect(actions).toBe(1); guard.close(); wait.release(); expect(await first).toBeUndefined(); expect(invalidations).toBe(1);
});

for (const change of ['close', 'workspace', 'token', 'project'] as const) test(`held discovery discards ${change} change before principal/journal/submission`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'submission-preflight-'));
  const first = join(home, 'first'); const second = join(home, 'second'); const workspace = join(home, 'selected');
  mkdirSync(first); mkdirSync(second); symlinkSync(first, workspace);
  writeFileSync(join(first, 'source.json'), JSON.stringify({ goal: 'Exact first source', criteria: [' first '] }));
  const arrived = gate(); const response = gate(); const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (path === '/api/work-ledger/project') { arrived.release(); await response.promise; return Response.json({ projectId: 'p' }); }
    if (path === '/api/work-ledger/snapshot') return Response.json({ projectId: 'p', revision: 0, cursor: 0, works: [] });
    if (path === '/api/work-ledger/history') return Response.json({ projectId: 'p', afterSequence: 0, throughSequence: 0, cursor: 0, hasMore: false, events: [] });
    return Response.json({ error: 'Unexpected submission action' }, { status: 500 });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`; const journalPath = join(home, 'journal.json');
  let token = 'synthetic-first-token';
  const view = createNativeWorkLedgerView(() => ({ baseUrl, workspace, token, journalPath }), () => {});
  const actions = { submit: () => view.submitFile!('source.json'), close: () => view.close(), project: () => view.selectProject('other') };
  try {
    const pending = actions.submit();
    expect((await actions.submit())?.status).toBe('pending'); // overlaps the first file read
    await arrived.promise;
    expect((await actions.submit())?.status).toBe('pending');
    if (change === 'close') actions.close();
    if (change === 'project') actions.project();
    if (change === 'workspace') { unlinkSync(workspace); symlinkSync(second, workspace); }
    if (change === 'token') { token = 'synthetic-replacement-token'; }
    response.release(); expect(await pending).toBeUndefined();
    expect(requests.filter(path => path === '/api/control-plane/auth' || path.includes('/submissions'))).toEqual([]);
    expect(existsSync(journalPath)).toBe(false);
  } finally { response.release(); actions.close(); server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
