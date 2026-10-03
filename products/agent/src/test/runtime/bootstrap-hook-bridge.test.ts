import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { createResumeSessionHandler } from '../../runtime/bootstrap-hook-bridge.ts';
import { createSessionSurface, readLastSessionPointer, writeLastSessionPointer } from '@/runtime/index.ts';
import type { SharedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('bootstrap hook bridge session resume', () => {
  test('resumes a session saved with an open-panels list without printing anything about panes', async () => {
    const logs: string[] = [];
    const tmpDir = makeProjectTempDir('gv-resume-legacy-panels');
    const sessionsDir = join(tmpDir, '.goodvibes', 'agent', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'saved-session.jsonl'), [
      JSON.stringify({
        type: 'meta',
        schemaVersion: 1,
        timestamp: 1_700_000_000_000,
        title: 'Pending work',
        model: 'gpt-5.4',
        provider: 'openai',
        titleSource: 'user',
        returnContext: {
          activityLabel: 'assistant replied',
          statusLabel: 'ready for next turn',
          pendingApprovals: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          assistantTurnCount: 1,
          userTurnCount: 1,
          openPanels: ['approval', 'tasks'],
          lines: ['Activity: assistant replied', 'Status: ready for next turn', 'Open panels: approval, tasks'],
        },
      }),
      JSON.stringify({ type: 'message', role: 'user', content: 'Review my pending work.' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'You have approvals waiting.' }),
    ].join('\n') + '\n');
    const sessionManager = new SessionManager(tmpDir, { surfaceRoot: 'agent' });
    const resume = createResumeSessionHandler({
      runtimeBus: { emit: () => {} } as never,
      runtime: {
        sessionId: 'current-session',
        model: 'gpt-5.4',
        provider: 'openai',
      } as never,
      conversation: {
        fromJSON: mock(() => {}),
        log: mock((message: string) => { logs.push(message); }),
      } as never,
      requestRender: mock(() => {}),
      onSessionIdChanged: mock((_sessionId: string) => null as SharedSessionRecord | null) as never,
      sharedSessionBroker: {
        reopenSession: mock(async () => null as SharedSessionRecord | null),
      },
      sessionSpineClient: {
        reopen: mock(() => {}),
      },
      projectRoot: '/project',
      writeLastSessionPointer: mock(() => {}),
      hookDispatcher: {
        fire: mock(async () => {}),
      } as never,
      sessionManager: sessionManager as never,
      configManager: {
        get: (key: string) => key === 'behavior.returnContextMode' ? 'summary' : undefined,
        getCategory: () => ({}),
      } as never,
      providerRegistry: {} as never,
    });

    resume('saved-session');
    await Promise.resolve();

    try {
      expect(logs).toContain('Resume: Status: ready for next turn');
      expect(logs.join('\n')).not.toMatch(/panel|\bpanes?\b/i);
      const loaded = sessionManager.load('saved-session').meta.returnContext as Record<string, unknown> | undefined;
      expect(loaded).toBeDefined();
      expect(loaded).not.toHaveProperty('openPanels');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Regression test for the arity-bug class: bootstrap.ts used to hand
  // createResumeSessionHandler the raw, two-argument SDK `writeLastSessionPointer`
  // reference directly. That reference is structurally assignable to the
  // `(sessionId: string) => void` slot this handler declares (a function with
  // an extra optional parameter satisfies a caller expecting fewer), so it
  // compiled fine, but `resume()` below calls `options.writeLastSessionPointer(sessionId)`
  // with exactly one argument, so `options` came through `undefined` on every
  // resume. writeLastSessionPointer's own try/catch swallows the resulting
  // "requires an explicit workingDirectory" failure into a logged warning, so
  // the pointer file was silently never written after a resume, the same bug
  // class that broke the TUI's resume journey. The fix is a surface-bound
  // closure (bootstrap.ts's `writeLastSessionPointerForSurface`); this test
  // exercises that exact shape end to end and proves the pointer lands on disk.
  test('a surface-bound writeLastSessionPointer closure actually persists the pointer file after resume', async () => {
    const workingDirectory = makeProjectTempDir('gv-resume-pointer-work');
    const homeDirectory = makeProjectTempDir('gv-resume-pointer-home');
    const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory, homeDirectory });

    // Mirrors bootstrap.ts's writeLastSessionPointerForSurface exactly: bound
    // to the surface, invoked here with the SAME one-argument call the real
    // resumeSession handler makes.
    const writeLastSessionPointerForSurface = (sessionId: string): void =>
      writeLastSessionPointer(sessionId, { surface });

    const resume = createResumeSessionHandler({
      runtimeBus: { emit: () => {} } as never,
      runtime: {
        sessionId: 'current-session',
        model: 'gpt-5.4',
        provider: 'openai',
      } as never,
      conversation: {
        fromJSON: mock(() => {}),
        log: mock(() => {}),
      } as never,
      requestRender: mock(() => {}),
      onSessionIdChanged: mock((_sessionId: string) => null as SharedSessionRecord | null) as never,
      sharedSessionBroker: {
        reopenSession: mock(async () => null as SharedSessionRecord | null),
      },
      sessionSpineClient: {
        reopen: mock(() => {}),
      },
      projectRoot: workingDirectory,
      writeLastSessionPointer: writeLastSessionPointerForSurface,
      hookDispatcher: {
        fire: mock(async () => {}),
      } as never,
      sessionManager: {
        load: mock(() => ({
          messages: [{ role: 'user', content: 'hello' }],
          meta: { title: 'Resumed', model: 'gpt-5.4', provider: 'openai' },
        })),
      } as never,
      configManager: {
        get: () => undefined,
        getCategory: () => ({}),
      } as never,
      providerRegistry: {} as never,
    });

    // Before resume: no pointer on disk yet.
    expect(readLastSessionPointer({ surface })).toBeNull();

    resume('resumed-session-id');
    await Promise.resolve();

    // After resume: the pointer file genuinely exists on disk and names the
    // resumed session, not just an in-memory claim.
    expect(readLastSessionPointer({ surface })).toBe('resumed-session-id');
    const raw = JSON.parse(readFileSync(surface.lastSessionPointer, 'utf-8')) as { sessionId: string };
    expect(raw.sessionId).toBe('resumed-session-id');
  });
});
