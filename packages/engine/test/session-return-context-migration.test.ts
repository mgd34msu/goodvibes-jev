import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SessionManager } from '../sdk/src/platform/sessions/manager.ts';
import { buildLocalReturnContextSummary, loadedReturnContext } from '../sdk/src/platform/runtime/operations.ts';
import { createSessionSurface } from '../sdk/src/platform/runtime/session-surface.ts';
import { checkRecoveryForSession, loadRecoveryConversation, writeRecoveryFile } from '../sdk/src/platform/runtime/session-recovery.ts';
import { loadLastConversation, persistConversation } from '../sdk/src/platform/runtime/session-persistence.ts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'return-context-migration-'));
  directories.push(dir);
  return dir;
}

function legacyContext() {
  return {
    activityLabel: 'assistant replied', statusLabel: 'ready for next turn',
    pendingApprovals: 2, toolCallCount: 3, toolResultCount: 3, assistantTurnCount: 1, userTurnCount: 1,
    lastUserPrompt: 'Open panels: this is the user’s actual text',
    lastAssistantReply: 'Keep this answer', assistedNarrative: 'Open panels: preserve this authored narrative',
    remoteRunners: ['runner-a'], worktreePaths: ['/synthetic/project'],
    openPanels: ['retired-pane'],
    lines: ['Activity: assistant replied', 'Open panels: retired-pane', 'Last prompt: Open panels: actual text'],
    futureMetadata: { version: 7, marker: 'preserve unknown record fields' },
  };
}
function expectedContext() {
  const { openPanels: _panes, ...rest } = legacyContext();
  return { ...rest, lines: ['Activity: assistant replied', 'Last prompt: Open panels: actual text'] };
}
function firstRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!);
}

describe('retired pane state in return context', () => {
  test('only the retired field and exact generated summary format are removed', () => {
    for (const raw of [undefined, null, 1, 'text', true, [], () => ({})]) expect(loadedReturnContext(raw)).toBeUndefined();
    const raw = legacyContext();
    const original = structuredClone(raw);
    expect(loadedReturnContext(raw)).toEqual(expectedContext());
    expect(raw).toEqual(original);
    expect(loadedReturnContext(loadedReturnContext(raw))).toEqual(expectedContext());
    const partial = {
      futureField: ['preserved'], openPanels: ['retired'],
      lines: ['Open panels: remove', 'open panels: keep', ' Open panels: keep', 'Open panels:keep', 'Quoted Open panels: keep', 12],
    };
    // These assertions intentionally compare raw partial legacy values, not newly authored summaries.
    expect<unknown>(loadedReturnContext(partial)).toEqual({
      futureField: ['preserved'],
      lines: ['open panels: keep', ' Open panels: keep', 'Open panels:keep', 'Quoted Open panels: keep', 12],
    });
    expect<unknown>(loadedReturnContext({ futureField: true })).toEqual({ futureField: true, lines: undefined });
  });

  test('new summaries ignore legacy pane hints while keeping explicit pending-approval facts', async () => {
    const hints = { pendingApprovals: 4, openPanels: ['retired-pane'], worktreeCount: 2 };
    const summary = await buildLocalReturnContextSummary([{ role: 'system', content: 'synthetic message' }], hints);
    expect(summary.pendingApprovals).toBe(4);
    expect(summary.worktreeCount).toBe(2);
    expect(summary).not.toHaveProperty('openPanels');
    expect(summary.lines.some((line) => line.startsWith('Open panels: '))).toBe(false);
  });

  test('pending approvals still come from the genuine reading seam when the host supplies no count', async () => {
    const syntheticMessage = 'synthetic stored statement with no policy keywords';
    const { port, requests } = fakePort((name, _question, state) => {
      if (name !== 'pending' || state !== syntheticMessage) throw new Error('Unexpected synthetic reading');
      return noulAnswer(0.99);
    });
    const previous = installJudgmentPort(port);
    try {
      const summary = await buildLocalReturnContextSummary([{ role: 'system', content: syntheticMessage }]);
      expect(summary.pendingApprovals).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.state).toBe(syntheticMessage);
      expect(loadedReturnContext({ ...summary, openPanels: ['retired-pane'] })?.pendingApprovals).toBe(1);
      expect(requests).toHaveLength(1);
    } finally { installJudgmentPort(previous); }
  });

  test('actual save, reload, metadata listing, fork-copy and rename cannot resurrect panes', () => {
    const directory = temporaryDirectory();
    const manager = new SessionManager('/unused', { sessionsDir: directory });
    const path = join(directory, 'original.jsonl');
    const meta = { type: 'meta', schemaVersion: 2, title: 'Original', model: 'test-model', provider: 'test-provider', timestamp: 123,
      titleSource: 'user', saveSource: 'user', returnContext: legacyContext() };
    const message = { role: 'tool', callId: 'call-a', toolName: 'read', content: 'Error: is successful data', outcome: 'ok' };
    // An existing version-two record, decoded and re-saved through the real
    // manager. Pane migration must not reinterpret its unrelated contract data.
    const contract = { id: 'contract-a', status: 'passed', sessionId: 'original', groups: [], units: [], provenance: 'retained' };
    const original = [meta, { type: 'message', ...message }, { type: 'contract', contract }].map((record) => JSON.stringify(record)).join('\n') + '\n';
    writeFileSync(path, original);
    const loaded = manager.load('original');
    expect(loaded.meta.returnContext).toEqual(expectedContext());
    expect(manager.getMeta('original')?.returnContext).toEqual(expectedContext());
    expect(manager.list()[0]?.returnContext).toEqual(expectedContext());
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect<unknown>(loaded.contracts).toEqual([contract]);
    expect(loaded.messages).toEqual([message]);

    manager.save('original', loaded.messages, { ...loaded.meta, saveSource: 'auto', returnContext: legacyContext() }, loaded.agentRecords, loaded.contracts);
    expect(firstRecord(path).returnContext).toEqual(expectedContext());
    expect(firstRecord(path).saveSource).toBe('user');
    expect<unknown>(manager.load('original').contracts).toEqual([contract]);
    manager.save('fork', loaded.messages, { ...loaded.meta, title: 'Fork' }, loaded.agentRecords, loaded.contracts);
    expect(manager.load('fork').meta.returnContext).toEqual(expectedContext());
    expect<unknown>(manager.load('fork').contracts).toEqual([contract]);
    expect(manager.load('fork').messages).toEqual([message]);

    writeFileSync(path, original);
    manager.rename('original', 'Renamed');
    expect(firstRecord(path).title).toBe('Renamed');
    expect(firstRecord(path).returnContext).toEqual(expectedContext());
    expect(firstRecord(path).saveSource).toBe('user');
    expect(readFileSync(path, 'utf8').split('\n').slice(1)).toEqual(original.split('\n').slice(1));
  });

  test('durable and recovery roundtrips sanitize old metadata without touching other session state', () => {
    const directory = temporaryDirectory();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory: join(directory, 'work'), homeDirectory: join(directory, 'home') });
    const options = { surface };
    const messages = [{ role: 'assistant', content: 'retained answer', followUp: true }];
    persistConversation('saved', { messages, returnContext: legacyContext() }, 'test-model', 'test-provider', 'Saved', options, 'user');
    // The existing load-last API deliberately returns messages only. Read the
    // persisted metadata through the real manager rather than expanding it.
    expect(new SessionManager('/unused', { surface }).load('saved').meta.returnContext).toEqual(expectedContext());
    expect(loadLastConversation(options)?.returnContext).toBeUndefined();
    expect(loadLastConversation(options)?.messages).toEqual(messages);
    expect(firstRecord(join(surface.sessionsDir, 'saved.jsonl')).saveSource).toBe('user');

    mkdirSync(surface.recoveryDir, { recursive: true });
    const recoveryPath = surface.recoveryFile('crashed');
    const original = [
      { type: 'meta', sessionId: 'crashed', title: 'Crash', timestamp: 123, titleSource: 'user', returnContext: legacyContext() },
      ...messages.map((message) => ({ type: 'message', ...message })),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n';
    writeFileSync(recoveryPath, original);
    expect(checkRecoveryForSession(surface, 'crashed')?.returnContext).toEqual(expectedContext());
    expect(loadRecoveryConversation(options, 'crashed')?.returnContext).toEqual(expectedContext());
    expect(readFileSync(recoveryPath, 'utf8')).toBe(original);
    const loaded = loadRecoveryConversation(options, 'crashed')!;
    writeRecoveryFile({ ...loaded, returnContext: legacyContext() }, 'copied', 'Copied', options);
    expect(firstRecord(surface.recoveryFile('copied')).returnContext).toEqual(expectedContext());
    expect(loadRecoveryConversation(options, 'copied')?.messages).toEqual(messages);
    expect(readFileSync(recoveryPath, 'utf8')).toBe(original);
  });
});
