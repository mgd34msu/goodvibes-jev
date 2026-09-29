/**
 * embed-session.test.ts
 *
 * Exercises the SDK Embedding API 1.0 facade (`createEmbeddedSession`) against a
 * real in-process daemon: the exposed seams (runtime bus, session broker,
 * approval broker), the injected permission-callback bridge, a spawn-mode submit
 * starting a contract through the daemon's contracts surface, and idempotent
 * shutdown. LLM-free, it drives the brokers directly rather than a full turn.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedSession, type EmbeddedSession } from '../sdk/src/embed.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.ts';

function makeRequest(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'read_file',
    args: { path: 'README.md' },
    category: 'read',
    analysis: { classification: 'read', riskLevel: 'low', summary: 'read a file', reasons: [] },
  };
}

describe('createEmbeddedSession', () => {
  let home: string;
  let work: string;
  let session: EmbeddedSession;
  const approved: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'embed-home-'));
    work = mkdtempSync(join(tmpdir(), 'embed-work-'));
    session = await createEmbeddedSession({
      workspace: work,
      homeDirectory: home,
      token: 'embed-test-token',
      boot: { daemonHomeDir: join(home, 'daemon'), port: 0, host: '127.0.0.1' },
      requestPermission: async (request) => {
        approved.push(request.callId);
        return { approved: request.category === 'read' };
      },
    });
  });

  afterAll(async () => {
    await session?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('exposes the workspace, url, and the in-process seams', () => {
    expect(session.workspace).toBe(work);
    expect(session.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(session.events).toBeInstanceOf(RuntimeEventBus);
    expect(typeof session.approvals.requestApproval).toBe('function');
    expect(typeof session.sessions.createSession).toBe('function');
  });

  test('the injected permission callback answers pending approvals', async () => {
    const decision = await session.approvals.requestApproval({
      request: makeRequest('call-read-1'),
      timeoutMs: 5000,
    });
    expect(decision.approved).toBe(true);
    expect(approved).toContain('call-read-1');
  });

  test('the callback can deny an ask', async () => {
    const denial = await session.approvals.requestApproval({
      request: { ...makeRequest('call-write-1'), tool: 'write_file', category: 'write' },
      timeoutMs: 5000,
    });
    expect(denial.approved).toBe(false);
  });

  test('the session broker seam creates a workspace-bound session', async () => {
    const record = await session.sessions.createSession({ project: work, title: 'embed' });
    expect(record.id.length).toBeGreaterThan(0);
  });

  test('a submit the broker answers in spawn mode starts a contract and binds its owner to the session', async () => {
    const created: { contractId: string; sessionId: string; origin: string; ask: string; ownerAgentId: string }[] = [];
    const unsubscribe = session.events.onDomain('contracts', (envelope) => {
      const payload = envelope.payload as { type: string; contractId: string; sessionId: string; origin: string; ask: string; ownerAgentId: string };
      if (payload.type === 'CONTRACT_CREATED') created.push(payload);
    });
    try {
      const submission = await session.submit({ body: 'Add a CHANGELOG entry for the export flag.', title: 'embed work' });
      expect(submission.mode).toBe('spawn');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ sessionId: submission.session.id, origin: 'external', ask: 'Add a CHANGELOG entry for the export flag.' });
      // The owner record is the agent working on the session's input.
      expect(submission.activeAgentId).toBe(created[0]!.ownerAgentId);
      expect(session.sessions.getSession(submission.session.id)?.activeAgentId).toBe(created[0]!.ownerAgentId);
    } finally {
      unsubscribe();
    }
  });

  test('stop is idempotent', async () => {
    await session.stop();
    await session.stop();
  });
});
