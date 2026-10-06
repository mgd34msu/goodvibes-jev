import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { NativeWorkSubmissionRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createNativeWorkLedgerHost, registerNativeWorkLedgerCommand } from '../../../runtime/native-work-ledger-host.ts';
import { CommandRegistry, type CommandContext } from '../../../input/command-registry.ts';

import { pairNativeTestHost } from '../../helpers/native-host-pairing.ts';

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-submit-product-'));
  const sourcePath = join(home, 'source with spaces.json');
  const original = { goal: '  Exact goal\nwith line break  ', criteria: [' first ', 'second\nline', ' first '] };
  writeFileSync(sourcePath, JSON.stringify(original));
  const requests: string[] = []; const submissions: NativeWorkSubmissionRequest[] = []; const lookups: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-submission-token');
    const path = new URL(request.url).pathname; requests.push(path);
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'paired-principal-fixture', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
    if (path === '/api/work-ledger/project') return Response.json({ projectId: 'p' });
    if (path === '/api/work-ledger/snapshot') return Response.json({ projectId: 'p', cursor: 0, revision: 0, works: [] });
    if (path === '/api/work-ledger/history') return Response.json({ projectId: 'p', afterSequence: 0, throughSequence: 0, cursor: 0, hasMore: false, events: [] });
    if (path === '/api/work-ledger/submissions') {
      const body = await request.json() as NativeWorkSubmissionRequest; submissions.push(body);
      return Response.json({ error: 'Synthetic lost acknowledgement', code: 'NATIVE_SUBMISSION_INDETERMINATE' }, { status: 503 });
    }
    if (path === '/api/work-ledger/submissions/get') {
      const body = await request.json() as { requestId: string }; lookups.push(body.requestId);
      const command = submissions.find(value => value.requestId === body.requestId);
      if (!command) return Response.json({ kind: 'not-found' });
      return Response.json({ kind: 'found', receipt: { projectId: 'p', requestId: command.requestId, inputId: command.inputId, ledgerRevision: 1, workId: 'new-native-work', attemptId: 'new-native-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, source: { version: 1, sourceId: 'source-fixture', sourceRevision: 'source-v1', sessionId: 'session-fixture' }, goal: command.goal, criteria: command.criteria } });
    }
    throw new Error(`Unexpected native action ${path}`);
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  await pairNativeTestHost(home, baseUrl, 'synthetic-submission-token');
  const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? baseUrl : undefined } as unknown as ConfigManager;
  const host = createNativeWorkLedgerHost({ configManager, homeDirectory: home, daemonHomeDirectory: home, journalPath: join(home, 'tui-state', 'native-submissions.json'), workspace: () => home });
  const printed: string[] = []; const registry = new CommandRegistry(); registerNativeWorkLedgerCommand(registry, host.selectProject, host.discoverProject, host.submission);
  const context = { print: (text: string) => printed.push(text) } as unknown as CommandContext;
  const run = async (action: string, path?: string) => { const parts = `/work ${action}${path ? ` ${path}` : ''}`.slice(1).split(/\s+/); await registry.execute(parts[0]!, parts.slice(1), context); };
  return { home, sourcePath, original, requests, submissions, lookups, run, printed,
    close() { host.submission.close(); server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}

test('real product command preserves source and uses original-ID lookup after lost acknowledgement without executing', async () => {
  const f = await fixture();
  try {
    await f.run('submit-file', pathToFileURL(f.sourcePath).href);
    expect(f.submissions).toHaveLength(1); expect(f.submissions[0]).toMatchObject({ expectedRevision: 0, ...f.original });
    expect(Object.keys(f.submissions[0]!).sort()).toEqual(['criteria', 'expectedRevision', 'goal', 'inputId', 'requestId']);
    expect(f.printed.join(' ')).toContain('outcome is unknown');
    writeFileSync(f.sourcePath, JSON.stringify({ goal: 'Changed after send', criteria: [] }));
    await f.run('submission-retry');
    expect(f.lookups).toEqual([f.submissions[0]!.requestId]); expect(f.submissions).toHaveLength(1);
    expect(f.printed.at(-1)).toContain('new-native-work'); expect(f.printed.at(-1)).toContain('new-native-attempt');
    expect(f.printed.at(-1)).toContain('No execution was started');
    expect(f.requests.some(path => path.includes('/execution/') || path.includes('/planning/'))).toBe(false);
  } finally { f.close(); }
});

test('invalid/missing criteria are refused by the command before any daemon call', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.sourcePath, JSON.stringify({ goal: 'Incomplete', criteria: [] }));
    await f.run('submit-file', pathToFileURL(f.sourcePath).href);
    expect(f.requests).toEqual([]); expect(f.printed.join(' ')).toContain('Criteria must');
  } finally { f.close(); }
});
