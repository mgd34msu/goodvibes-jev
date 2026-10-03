import { describe, expect, test } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import {
  checkRecoveryFile,
  consumeRecovery,
  createSessionSurface,
  removeRecoveryPoint,
  writeRecoveryFile,
} from '@/runtime/index.ts';

import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeRecoverySurface() {
  const home = makeProjectTempDir('gv-agent-blocking-input-recovery-home');
  const work = makeProjectTempDir('gv-agent-blocking-input-recovery-work');
  return createSessionSurface({ surfaceRoot: 'agent', workingDirectory: work, homeDirectory: home });
}

function makeConversation() {
  const restored: Array<Record<string, unknown>>[] = [];
  return {
    restored,
    conversation: {
      fromJSON: ({ messages }: { messages: Array<Record<string, unknown>> }) => {
        restored.push(messages);
      },
    },
  };
}

function makeRouter() {
  const messages: string[] = [];
  return {
    messages,
    router: {
      high: (text: string) => messages.push(text),
    },
  };
}

describe('shell/blocking-input', () => {
  test('approves pending permission on y', () => {
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let rendered = 0;
    let aborted = 0;

    const pendingPermission = {
      id: 'perm-1',
      toolName: 'write',
      reason: 'Need approval',
      resolve: (approved: boolean, remember?: boolean) => {
        resolved.push([approved, remember]);
      },
    } as unknown as PendingPermissionState;

    const result = handleBlockingShellInput({
      data: 'y',
      pendingPermission,
      recoveryPending: null,
      daemonRepairPrompt: null,
      abortTurn: () => { aborted++; },
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      consumeRecovery: () => null,
      removeRecoveryPoint: () => {},
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
    expect(aborted).toBe(0);
    expect(rendered).toBe(1);
  });

  test('denies pending permission on escape and aborts turn', () => {
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let rendered = 0;
    let aborted = 0;

    const pendingPermission = {
      id: 'perm-2',
      toolName: 'write',
      reason: 'Need approval',
      resolve: (approved: boolean, remember?: boolean) => {
        resolved.push([approved, remember]);
      },
    } as unknown as PendingPermissionState;

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission,
      recoveryPending: null,
      daemonRepairPrompt: null,
      abortTurn: () => { aborted++; },
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      consumeRecovery: () => null,
      removeRecoveryPoint: () => {},
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[false, false]]);
    expect(aborted).toBe(1);
    expect(rendered).toBe(1);
  });

  test('restores recovery snapshot on ctrl-r', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let consumed = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: 'recovery-session-1',
      daemonRepairPrompt: null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      // consumeRecovery (SDK primitive) loads AND retires the snapshot in one
      // operation, there is no separate delete callback for this branch.
      consumeRecovery: () => {
        consumed++;
        return { messages: [{ role: 'user', content: 'restored' }] };
      },
      removeRecoveryPoint: () => {},
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBeNull();
    expect(restored).toEqual([[{ role: 'user', content: 'restored' }]]);
    expect(messages).toContain('[Recovery] Session restored.');
    expect(consumed).toBe(1);
    expect(rendered).toBe(1);
  });

  test('passes normal typing through while dismissing recovery', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let removed = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: 'h',
      pendingPermission: null,
      recoveryPending: 'recovery-session-1',
      daemonRepairPrompt: null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      consumeRecovery: () => ({
        messages: [{ role: 'user', content: 'restored' }],
      }),
      removeRecoveryPoint: () => { removed++; },
    });

    expect(result.handled).toBe(false);
    expect(result.recoveryPending).toBeNull();
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Ignored saved session; starting a new prompt.');
    expect(removed).toBe(1);
    expect(rendered).toBe(1);
  });

  test('discards recovery on escape without passing escape to input', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let removed = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission: null,
      recoveryPending: 'recovery-session-1',
      daemonRepairPrompt: null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      consumeRecovery: () => ({
        messages: [{ role: 'user', content: 'restored' }],
      }),
      removeRecoveryPoint: () => { removed++; },
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBeNull();
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Discarded recovery data.');
    expect(removed).toBe(1);
    expect(rendered).toBe(1);
  });

});

// ── Real-SDK regression: recovery targets exactly the OFFERED snapshot ──────
//
// Reproduces the actual production wiring (see main.ts's stdin 'data' handler):
// checkRecoveryFile picks the newest snapshot to offer, and the
// consumeRecovery/removeRecoveryPoint closures must be keyed to THAT
// sessionId, never a keyless call that would touch every snapshot in the
// scoped recovery directory. Uses the real SDK session-persistence primitives
// against real files on disk (no mocks) so the raw filesystem state is the
// proof.
describe('shell/blocking-input: recovery targets exactly the offered snapshot', () => {
  function makeTwoSnapshots() {
    const surface = makeRecoverySurface();
    // Two independent sessions each have their own crash-recovery snapshot.
    writeRecoveryFile({ messages: [{ role: 'user', content: 'older session' }] }, 'session-older', 'Older', { surface });
    writeRecoveryFile({ messages: [{ role: 'user', content: 'newer session' }] }, 'session-newer', 'Newer', { surface });
    // checkRecoveryFile offers the newest-by-mtime snapshot; force a
    // deterministic ordering instead of relying on write-call timing.
    const olderPath = surface.recoveryFile('session-older');
    const newerPath = surface.recoveryFile('session-newer');
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 700, now - 700);
    utimesSync(newerPath, now - 600, now - 600);
    return { surface, olderPath, newerPath };
  }

  test('Ctrl+R consumes and retires the offered snapshot only', () => {
    const { surface, olderPath, newerPath } = makeTwoSnapshots();
    const offered = checkRecoveryFile({ surface });
    expect(offered?.sessionId).toBe('session-newer');

    const { conversation, restored } = makeConversation();
    const { router } = makeRouter();

    const result = handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: offered!.sessionId,
      daemonRepairPrompt: null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      consumeRecovery: () => consumeRecovery(surface, offered!.sessionId).snapshot,
      removeRecoveryPoint: () => { removeRecoveryPoint(surface, offered!.sessionId); },
    });

    expect(result.handled).toBe(true);
    expect(restored).toEqual([[{ role: 'user', content: 'newer session' }]]);
    // Raw-disk proof: the offered (newer) snapshot is gone; the other
    // session's snapshot is untouched.
    expect(existsSync(newerPath)).toBe(false);
    expect(existsSync(olderPath)).toBe(true);
  });

  test('Esc removes the offered snapshot only', () => {
    const { surface, olderPath, newerPath } = makeTwoSnapshots();
    const offered = checkRecoveryFile({ surface });
    expect(offered?.sessionId).toBe('session-newer');

    const { conversation } = makeConversation();
    const { router } = makeRouter();

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission: null,
      recoveryPending: offered!.sessionId,
      daemonRepairPrompt: null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      consumeRecovery: () => consumeRecovery(surface, offered!.sessionId).snapshot,
      removeRecoveryPoint: () => { removeRecoveryPoint(surface, offered!.sessionId); },
    });

    expect(result.handled).toBe(true);
    // Raw-disk proof: the offered (newer) snapshot is gone; the other
    // session's snapshot is untouched.
    expect(existsSync(newerPath)).toBe(false);
    expect(existsSync(olderPath)).toBe(true);
  });
});

// ── Real-SDK regression: exit retires only the exiting session's snapshot ──
//
// main.ts's exitApp calls removeRecoveryPoint(ctx.services.surface,
// runtime.sessionId), scoped to the session that is actually exiting. A
// keyless call (removeRecoveryPoint(surface) with no sessionId) clears every
// snapshot in the scoped recovery directory, including offers the user never
// answered and, in a dual-session workdir, the OTHER session's still-live
// snapshot. This exercises the exact same real SDK primitive main.ts's exit
// path calls, keyed the same way, against real files on disk.
describe('shell/blocking-input: exit removes only the exiting session snapshot', () => {
  test('removeRecoveryPoint(surface, sessionId) retires only that session, leaving a second session snapshot intact', () => {
    const surface = makeRecoverySurface();
    writeRecoveryFile({ messages: [{ role: 'user', content: 'exiting session' }] }, 'session-exiting', 'Exiting', { surface });
    writeRecoveryFile({ messages: [{ role: 'user', content: 'other live session' }] }, 'session-other', 'Other', { surface });
    const exitingPath = surface.recoveryFile('session-exiting');
    const otherPath = surface.recoveryFile('session-other');
    expect(existsSync(exitingPath)).toBe(true);
    expect(existsSync(otherPath)).toBe(true);

    // The exact call main.ts's exitApp makes: keyed to the exiting session's runtime.sessionId.
    removeRecoveryPoint(surface, 'session-exiting');

    expect(existsSync(exitingPath)).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
  });
});
