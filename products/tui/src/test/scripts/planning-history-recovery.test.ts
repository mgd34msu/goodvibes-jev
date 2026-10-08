import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KnowledgeStore, type KnowledgeSourceRecord } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { pairNativeTestHost } from '../helpers/native-host-pairing.ts';
import historicalFixture from '../fixtures/legacy-ledger/preparation.json';

const historical = structuredClone(historicalFixture);
const stateSource = historical.sources[0]!.source;
stateSource.canonicalUri = `goodvibes://planning/project%3A${historical.projectId}/state/current`;
stateSource.metadata.planningArtifactId = 'current';
stateSource.metadata.value.id = 'current';

const root = resolve(import.meta.dir, '../../..');
const entrypoint = 'src/test/fixtures/planning-history-recovery.ts';
const source = '  Original owner request\r\n界 e\u0301 😀\t  ';

async function run(argv: string[], cwd: string, timeoutMs = 20_000) {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, HOME: cwd }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' }); return stdout;
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}

test('compiled TUI history → native ledger → process restart recovers the exact owner source once without changing saved approval', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tui-history-recovery-'));
  const dbPath = join(home, 'history.sqlite'); const journalPath = join(home, 'native.json.intake');
  const binary = join(home, process.platform === 'win32' ? 'history-recovery.exe' : 'history-recovery');
  const prepared = prepareLegacyWorkLedgerMigration(historical);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 300);
  const event = { type: 'import_legacy', sequence: 1, actorId: 'historical-import-owner', requestId: 'saved-import', at: 300, manifest: prepared.manifest, works };
  const snapshot = { projectId: historical.projectId, revision: 1, cursor: 1, provenance: 'available', works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical claim only', evidence: null }, attention: [] })) };
  const requests: string[] = []; const captures: NativeConversationIntakeCaptureRequest[] = [];
  const states = new Map<string, NativeConversationIntakeResult>(); const unexpected: string[] = [];
  const common = (command: NativeConversationIntakeCaptureRequest) => ({ projectId: historical.projectId, requestId: command.requestId,
    sourceRef: { version: 1 as const, inputId: command.inputId, sourceId: 'original-native-source', sourceRevision: 'r1', sessionId: 'host-session' } });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-history-recovery-token');
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: 'paired-history-recovery', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'read:knowledge', 'write:work-ledger'], roles: [] });
    if (path === '/api/work-ledger/snapshot') return Response.json(snapshot);
    if (path === '/api/work-ledger/history') return Response.json({ projectId: historical.projectId, afterSequence: Number(new URL(request.url).searchParams.get('afterSequence') ?? 0), throughSequence: 1, cursor: 1, provenance: 'available', hasMore: false, events: Number(new URL(request.url).searchParams.get('afterSequence') ?? 0) ? [] : [event] });
    if (path === '/api/work-ledger/intake/capture') {
      const command = await request.json() as NativeConversationIntakeCaptureRequest; captures.push(command);
      expect(command.text).toBe(source);
      expect(JSON.parse(readFileSync(journalPath, 'utf8')).records[0].command).toEqual(command);
      const result: NativeConversationIntakeResult = { ...common(command), kind: 'captured' }; states.set(command.inputId, result); return Response.json(result);
    }
    if (path === '/api/work-ledger/intake/get') {
      const { inputId } = await request.json() as { inputId: string }; return Response.json(states.get(inputId) ?? { kind: 'not-found' });
    }
    if (path === '/api/work-ledger/intake/admit' || path === '/api/work-ledger/intake/resume') {
      const { inputId, sourceRevision } = await request.json() as { inputId: string; sourceRevision: string };
      const command = captures.find(capture => capture.inputId === inputId)!; expect(sourceRevision).toBe('r1'); expect(command).toBeDefined();
      const result: NativeConversationIntakeResult = { ...common(command), kind: 'turn', route: 'answer', text: command.text }; states.set(inputId, result);
      return path.endsWith('/admit') ? Response.json({ error: 'Synthetic acknowledgement lost after native admission' }, { status: 503 }) : Response.json(result);
    }
    unexpected.push(path); return Response.json({ error: 'Unexpected fixture route' }, { status: 500 });
  } });
  try {
    const store = new KnowledgeStore({ dbPath }); await store.init();
    try { for (const { source } of historical.sources) await store.replaceSourceRecord(source as KnowledgeSourceRecord); } finally { await store.close(); }
    const historicalBytes = readFileSync(dbPath);
    await pairNativeTestHost(home, server.url.origin, 'synthetic-history-recovery-token');
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    await run([process.execPath, 'scripts/compile.ts', entrypoint, '--compile', `--target=bun-${platform}-${process.arch}`, '--outfile', binary], root, 60_000);
    const launch = async (mode: string) => JSON.parse(await run([binary, mode, home, server.url.origin, historical.projectId], home)) as {
      mode: string; opened: string[]; output: string[]; dispatched: { text: string; requestId: string; inputId: string }[]; historicalUnchanged: boolean; judgmentReads: number;
    };
    const first = await launch('submit');
    expect(first.opened).toEqual(['planning-modal', 'native-work-ledger-modal', 'planning-modal', 'native-work-ledger-modal']);
    expect(first.dispatched).toEqual([]); expect(first.historicalUnchanged).toBe(true); expect(first.judgmentReads).toBe(0);
    expect(captures).toHaveLength(1); expect(captures[0]?.text).toBe(source); expect(readFileSync(dbPath)).toEqual(historicalBytes);
    const originalCommand = JSON.parse(readFileSync(journalPath, 'utf8')).records[0].command;
    const second = await launch('recover');
    expect(second.opened).toEqual(['planning-modal', 'native-work-ledger-modal']);
    expect(second.dispatched).toEqual([{ text: source, requestId: originalCommand.requestId, inputId: originalCommand.inputId }]);
    expect(second.historicalUnchanged).toBe(true); expect(second.judgmentReads).toBe(0);
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).records[0]).toMatchObject({ command: originalCommand, dispatch: { sourceRevision: 'r1' } });
    const third = await launch('recover'); expect(third.dispatched).toEqual([]);
    expect(captures).toHaveLength(1); expect(requests.filter(path => path.endsWith('/admit'))).toHaveLength(1);
    expect(requests.filter(path => path.endsWith('/resume'))).toHaveLength(1);
    expect(requests.some(path => path.includes('/execution/') || path.includes('/planning/') || path.includes('/submissions') || path.includes('/legacy-import'))).toBe(false);
    expect(unexpected).toEqual([]); expect(readFileSync(dbPath)).toEqual(historicalBytes);
    expect(readFileSync(journalPath, 'utf8')).not.toContain('synthetic-history-recovery-token');
  } finally { await server.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 90_000);
