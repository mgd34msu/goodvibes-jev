/**
 * health-approvals-command.test.ts
 *
 * `/health approvals` reads the daemon's record, not this process's broker
 * alone, and when it cannot read it, it says so before printing anything that
 * could be mistaken for "nothing is waiting".
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';
import type { ApprovalsPanelSnapshot, ApprovalsView } from '../../runtime/client/approvals-view.ts';
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';

function approval(id: string, tool: string, sessionId?: string): SharedApprovalRecord {
  return {
    id,
    callId: `call-${id}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    status: 'pending',
    request: { callId: `call-${id}`, tool, args: {}, category: 'exec', analysis: { risk: 'low', reasons: [] } },
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    audit: [],
  } as unknown as SharedApprovalRecord;
}

function stubView(snapshot: Omit<ApprovalsPanelSnapshot, 'liveUpdates'> & { liveUpdates?: boolean }): ApprovalsView {
  const full: ApprovalsPanelSnapshot = { liveUpdates: false, ...snapshot };
  return {
    snapshot: () => full,
    refresh: async () => full,
    start: () => {},
    stop: () => {},
  };
}

function makeContext(out: string[], view: ApprovalsView | undefined): CommandContext {
  return {
    print: (text: string) => { out.push(text); },
    ops: { approvalsView: view },
  } as unknown as CommandContext;
}

async function runHealthApprovals(view: ApprovalsView | undefined): Promise<string> {
  const registry = new CommandRegistry();
  registerHealthRuntimeCommands(registry);
  const command = registry.get('health');
  expect(command).toEqual(expect.objectContaining({ name: 'health', handler: expect.any(Function) }));
  const out: string[] = [];
  await command!.handler(['approvals'], makeContext(out, view));
  return out.join('\n');
}

describe('/health approvals', () => {
  test('a pending ask on the daemon appears in the panel', async () => {
    const text = await runHealthApprovals(stubView({
      approvals: [approval('host-1', 'bash', 'session-a')],
      hostRecordRead: true,
      unavailableReason: null,
      localOnlyCount: 0,
    }));

    expect(text).toContain('Health Review Approvals');
    expect(text).toContain('source connected host record + this process');
    expect(text).toContain('waiting 1');
    expect(text).toContain('pending bash session session-a (host-1)');
    expect(text).not.toContain('could not be read');
  });

  test('an unreachable host renders the reason, not an empty list', async () => {
    const text = await runHealthApprovals(stubView({
      approvals: [],
      hostRecordRead: false,
      unavailableReason: 'the connected host is disabled (daemon.enabled=false), nothing to reach.',
      localOnlyCount: 0,
    }));

    expect(text).toContain('could not be read');
    expect(text).toContain('daemon.enabled=false');
    expect(text).toContain('not the same as nothing waiting');
    expect(text).toContain('source this process only');
    // The list line must not read as a clean "nothing pending".
    expect(text).toContain('the host was not read, so it may still hold asks');
    expect(text).not.toContain('nothing is waiting on the connected host or in this process');
  });

  test('the panel says whether the list is live or a periodic re-read', async () => {
    const live = await runHealthApprovals(stubView({
      approvals: [],
      hostRecordRead: true,
      unavailableReason: null,
      localOnlyCount: 0,
      liveUpdates: true,
    }));
    expect(live).toContain('updates live from the connected host');

    const polled = await runHealthApprovals(stubView({
      approvals: [],
      hostRecordRead: true,
      unavailableReason: null,
      localOnlyCount: 0,
    }));
    expect(polled).toContain('updates periodic re-read (no live stream)');
  });

  test('an unreachable host still shows the asks this process holds, and labels them', async () => {
    const text = await runHealthApprovals(stubView({
      approvals: [approval('bridge-1', 'write')],
      hostRecordRead: false,
      unavailableReason: 'the request failed (503): host unavailable',
      localOnlyCount: 1,
    }));

    expect(text).toContain('the request failed (503)');
    expect(text).toContain('1 ask raised in this process is shown below');
    expect(text).toContain('raised in this process and not on the host 1');
    expect(text).toContain('pending write (bridge-1)');
  });

  test('a runtime with no approvals view says nothing was read rather than nothing is waiting', async () => {
    const text = await runHealthApprovals(undefined);
    expect(text).toContain('not wired in this runtime');
    expect(text).toContain('This is not "no approvals waiting", nothing was read.');
  });
});
