/**
 * First-start registration prompt (owner-approved design): wireSessionPersistenceAndRecovery
 * decides whether to ask the "register this workspace?" question, and records
 * the answer. The question itself is a selection modal
 * (shell/workspace-registration-question.ts); here it is a recorder, and the
 * answer is driven through the callback the modal would call.
 */
import { describe, expect, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { createSessionSurface, createShellPathService, writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { writeOnboardingCompletionMarker } from '../../runtime/onboarding/index.ts';
import { createWorkspaceRegistrationStore } from '../../config/workspace-registration.ts';
import { wireSessionPersistenceAndRecovery, type SessionPersistenceAndRecoveryDeps } from '../../shell/startup-wiring.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function pollUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

function makeRoots() {
  const home = makeProjectTempDir('gv-agent-startup-wiring-reg-home');
  const work = makeProjectTempDir('gv-agent-startup-wiring-reg-work');
  return { home, work, shellPaths: createShellPathService({ workingDirectory: work, homeDirectory: home }) };
}

function makeSurface(workingDirectory: string, homeDirectory: string): SessionSurface {
  return createSessionSurface({ surfaceRoot: 'agent', workingDirectory, homeDirectory });
}

function markOnboardingDone(shellPaths: ReturnType<typeof createShellPathService>): void {
  writeOnboardingCompletionMarker(shellPaths, { scope: 'user', checkedAt: 1000, source: 'wizard' });
}

function makeDeps(overrides: Partial<SessionPersistenceAndRecoveryDeps> & { workingDir: string; homeDirectory: string }): { deps: SessionPersistenceAndRecoveryDeps; messages: string[]; renderCount: () => number; asked: Array<{ root: string; answer: (accepted: boolean) => void }> } {
  const messages: string[] = [];
  const asked: Array<{ root: string; answer: (accepted: boolean) => void }> = [];
  let renders = 0;
  const deps: SessionPersistenceAndRecoveryDeps = {
    buildCurrentSessionSnapshot: () => ({ messages: [], timestamp: Date.now(), title: 'test' }),
    runtime: { sessionId: 'test-session', model: 'mock-model', provider: 'mock' },
    conversation: { title: 'test' },
    systemMessageRouter: { high: (m: string) => messages.push(m), low: () => {} },
    render: () => { renders += 1; },
    unsubs: [],
    uiServicesTurns: { on: () => () => {} },
    hookDispatcher: { fire: async () => {} } as never,
    surface: makeSurface(overrides.workingDir, overrides.homeDirectory),
    onStreamSpeedUpdate: () => {},
    askWorkspaceRegistration: (root, answer) => { asked.push({ root, answer }); },
    ...overrides,
  };
  return { deps, messages, renderCount: () => renders, asked };
}

describe('wireSessionPersistenceAndRecovery: first-start registration prompt', () => {
  test('an unknown, non-broad, onboarding-complete workspace is asked about, once, and no message stands in for the question', () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    const { deps, messages, asked } = makeDeps({ workingDir: work, homeDirectory: home });

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.workspaceRegistrationAsked).toBe(work);
    expect(asked.map((entry) => entry.root)).toEqual([work]);
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });

  test('answering register records the workspace as covered and says so', async () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    const { deps, messages, asked, renderCount } = makeDeps({ workingDir: work, homeDirectory: home });
    clearInterval(wireSessionPersistenceAndRecovery(deps).recoveryInterval);

    asked[0]!.answer(true);

    expect(messages.some((m) => m.includes('Registered') && m.includes(work))).toBe(true);
    expect(renderCount()).toBeGreaterThanOrEqual(1);
    const store = createWorkspaceRegistrationStore(shellPaths);
    expect(await pollUntil(async () => (await store.resolve(work)).status === 'covered')).toBe(true);
  });

  test('answering no (or closing the question) records a decline, so it is not asked again', async () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    const first = makeDeps({ workingDir: work, homeDirectory: home });
    clearInterval(wireSessionPersistenceAndRecovery(first.deps).recoveryInterval);

    first.asked[0]!.answer(false);

    expect(first.messages.some((m) => m.includes('Not registered'))).toBe(true);
    const store = createWorkspaceRegistrationStore(shellPaths);
    expect(await pollUntil(async () => (await store.resolve(work)).status === 'declined')).toBe(true);
    const second = makeDeps({ workingDir: work, homeDirectory: home });
    clearInterval(wireSessionPersistenceAndRecovery(second.deps).recoveryInterval);
    expect(second.asked).toEqual([]);
  });

  test('onboarding not yet complete: no prompt (avoids competing with the onboarding wizard)', () => {
    const { work, home } = makeRoots();
    const { deps, messages } = makeDeps({ workingDir: work, homeDirectory: home });

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.workspaceRegistrationAsked).toBeNull();
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });

  test('a broad root (home directory) is never offered for registration', () => {
    const home = makeProjectTempDir('gv-agent-startup-wiring-reg-broad');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    markOnboardingDone(shellPaths);
    const { deps, messages } = makeDeps({ workingDir: home, homeDirectory: home });

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.workspaceRegistrationAsked).toBeNull();
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });

  test('an already-registered workspace does not re-prompt', async () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    await createWorkspaceRegistrationStore(shellPaths).add(work);
    const { deps, messages } = makeDeps({ workingDir: work, homeDirectory: home });

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.workspaceRegistrationAsked).toBeNull();
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });

  test('an already-declined workspace does not re-prompt', async () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    await createWorkspaceRegistrationStore(shellPaths).decline(work);
    const { deps, messages } = makeDeps({ workingDir: work, homeDirectory: home });

    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.workspaceRegistrationAsked).toBeNull();
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });

  test('a pending recovery prompt takes priority over the registration prompt', () => {
    const { work, home, shellPaths } = makeRoots();
    markOnboardingDone(shellPaths);
    // Seed a real recovery file (via the same helper the module itself uses
    // to write one) so checkRecoveryFile reports one pending on the next call.
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'hi' } as never], timestamp: Date.now(), title: 'test' },
      'test-session', 'test', { surface: makeSurface(work, home) },
    );
    // Back-date the snapshot past the live-refresh window: a fresh file reads
    // as a live writer's and is deliberately never offered.
    {
      const aged = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(makeSurface(work, home).recoveryFile('test-session'), aged, aged);
    }

    const { deps, messages } = makeDeps({ workingDir: work, homeDirectory: home });
    const result = wireSessionPersistenceAndRecovery(deps);
    clearInterval(result.recoveryInterval);

    expect(result.recoveryPending).toBe('test-session');
    expect(result.workspaceRegistrationAsked).toBeNull();
    expect(messages.some((m) => m.includes('[Workspace]'))).toBe(false);
  });
});
