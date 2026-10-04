import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeWorkSubmissionRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';

async function within<T>(promise: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Child submission did not settle')), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('SIGKILL after server persistence recovers the same journal identity across process restart without cross-principal replay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-submit-crash-')); const journalPath = join(home, 'product-state', 'native-work-submission.json');
  const sourcePath = join(home, 'source.json'); const script = join(home, 'client.ts');
  const original = { goal: '  Crash-safe original goal\n  ', criteria: [' first ', 'second', ' first '] };
  writeFileSync(sourcePath, JSON.stringify(original));
  let command: NativeWorkSubmissionRequest | undefined; let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; }); const mutations: string[] = []; const lookups: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname; const replacement = request.headers.get('authorization') === 'Bearer synthetic-replacement-token';
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: replacement ? 'principal-replacement' : 'principal-original', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
    if (path === '/api/work-ledger/snapshot') return Response.json({ projectId: 'p', revision: 0, cursor: 0, works: [] });
    if (path === '/api/work-ledger/submissions') {
      mutations.push(path); command = await request.json() as NativeWorkSubmissionRequest;
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { records: { command: NativeWorkSubmissionRequest }[] };
      expect(journal.records[0]?.command).toEqual(command); // durable publication preceded the first POST
      received(); return await new Promise<Response>(() => {}); // acknowledgement never reaches the child
    }
    if (path === '/api/work-ledger/submissions/get') {
      const input = await request.json() as { requestId: string }; lookups.push(input.requestId);
      if (!command || input.requestId !== command.requestId || replacement) return Response.json({ kind: 'not-found' });
      return Response.json({ kind: 'found', receipt: { projectId: 'p', requestId: command.requestId, inputId: command.inputId, ledgerRevision: 1, workId: 'crash-work', attemptId: 'crash-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, source: { version: 1, sourceId: 'source-crash', sourceRevision: 'source-v1', sessionId: 'session-crash' }, goal: command.goal, criteria: command.criteria } });
    }
    throw new Error(`Unexpected method: ${path}`);
  } });
  const controlModule = new URL('../../../runtime/native-work-submission.ts', import.meta.url).href;
  const hostModule = new URL('../../../runtime/native-work-submission-host.ts', import.meta.url).href;
  const journalModule = new URL('../../../runtime/native-work-submission-journal.ts', import.meta.url).href;
  writeFileSync(script, `import { NativeWorkSubmissionControls } from ${JSON.stringify(controlModule)};
import { createNativeWorkSubmissionBinding, nativeSubmissionIdentity } from ${JSON.stringify(hostModule)};
import { NativeWorkSubmissionJournal } from ${JSON.stringify(journalModule)};
const host = { baseUrl: ${JSON.stringify(`http://127.0.0.1:${server.port}`)}, token: process.argv[3], workspace: ${JSON.stringify(home)}, journalPath: ${JSON.stringify(journalPath)} };
const controls = new NativeWorkSubmissionControls(() => ({ available: true, identity: nativeSubmissionIdentity(host, 'p'), endpoint: host.baseUrl, projectId: 'p', workspace: host.workspace, journal: new NativeWorkSubmissionJournal(host.journalPath), bind: () => createNativeWorkSubmissionBinding(host, 'p') }));
try { const result = process.argv[2] === 'submit' ? await controls.submitFile(${JSON.stringify(sourcePath)}) : await controls.retry(); console.log(JSON.stringify(result)); } finally { controls.close(); }
`);
  const launch = (mode: string, token = 'synthetic-original-token') => Bun.spawn([process.execPath, '--no-env-file', script, mode, token], { stdout: 'pipe', stderr: 'pipe' });
  const children: ReturnType<typeof launch>[] = [];
  try {
    const first = launch('submit'); children.push(first); await within(arrived);
    first.kill('SIGKILL'); await within(first.exited);
    expect(command).toMatchObject({ expectedRevision: 0, ...original });
    const bytes = readFileSync(journalPath, 'utf8'); expect(bytes).not.toContain('synthetic-original-token'); expect(bytes).not.toContain('synthetic-replacement-token');
    rmSync(sourcePath); // restart recovery cannot reread or rebuild the original source
    const other = launch('retry', 'synthetic-replacement-token'); children.push(other);
    const [otherExit, otherOut, otherError] = await within(Promise.all([other.exited, new Response(other.stdout).text(), new Response(other.stderr).text()]));
    expect(otherExit).toBe(0); expect(otherError).toBe(''); expect(JSON.parse(otherOut).status).toBe('unavailable'); expect(lookups).toEqual([]); expect(mutations).toHaveLength(1);
    const restored = launch('retry'); children.push(restored);
    const [exit, output, error] = await within(Promise.all([restored.exited, new Response(restored.stdout).text(), new Response(restored.stderr).text()]));
    expect(exit).toBe(0); expect(error).toBe(''); const result = JSON.parse(output);
    expect(result.status).toBe('submitted'); expect(result.receipt.requestId).toBe(command!.requestId); expect(result.receipt.inputId).toBe(command!.inputId);
    expect(result.receipt.goal).toBe(original.goal); expect(result.receipt.criteria).toEqual(original.criteria);
    expect(lookups).toEqual([command!.requestId]); expect(mutations).toEqual(['/api/work-ledger/submissions']);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    server.stop(true); rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
