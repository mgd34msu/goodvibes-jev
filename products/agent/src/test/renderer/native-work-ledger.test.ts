import { expect, test } from 'bun:test';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentWorkspaceRuntimeCommands } from '../../input/commands/agent-workspace-runtime.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import { handleAgentWorkspaceToken } from '../../input/agent-workspace-token.ts';
import type { NativeWorkLedgerState } from '../../runtime/native-work-ledger.ts';
const plain = (workspace: AgentWorkspace) => renderAgentWorkspace(workspace, 132, 42).lines.map(line => line.map(cell => cell.char ?? ' ').join('')).join('\n');
test('/work selects daemon project, opens real renderer and scrolls to stable evidence; close/reopen owns reader lifecycle', async () => {
  const calls: string[] = [];
  const state: NativeWorkLedgerState = { status: 'ready', cursor: 0, history: [], snapshot: { projectId: 'project-host', cursor: 0, revision: 0, works: [{
    work: { id: 'work-stable', title: 'Deliver', goal: 'Native intent', revision: 4, criteriaRevision: 2, reportedState: 'complete', currentAttemptId: 'attempt-stable', createdAt: 1, updatedAt: 2, criteria: Array.from({ length: 15 }, (_, i) => `Criterion ${i}`) },
    attempt: { id: 'attempt-stable', workId: 'work-stable', predecessorId: 'attempt-old', ownerId: 'owner', revision: 3, state: 'complete', report: 'Reported finished', blocker: null, createdAt: 1, updatedAt: 2 },
    verification: { state: 'stale', reason: 'Criteria changed', evidence: { id: 'evidence-stable', target: { workId: 'work-stable', workRevision: 3, criteriaRevision: 1, attemptId: 'attempt-old', attemptRevision: 2 }, outcome: 'verified', reason: 'Previous revision passed', source: 'host_check', criteriaResults: [], actorId: 'verifier', at: 1, references: [{ kind: 'commit', ref: 'commit-abc', digest: 'sha256:old' }] } },
    attention: [{ kind: 'verification', reason: 'Recheck current criteria' }],
  }] } };
  const workspace = new AgentWorkspace();
  const context = { print: () => {}, executeCommand: async () => true,
    nativeWorkLedger: { state, selectProject: (id: string) => calls.push(`select:${id}`), open: () => calls.push('open'), close: () => calls.push('close'), sync: () => {} },
    openAgentWorkspace: (category: string) => workspace.open(context, async () => {}, category),
  } as unknown as CommandContext;
  const registry = new CommandRegistry(); registerAgentWorkspaceRuntimeCommands(registry); await registry.execute('work', ['project-host'], context);
  expect(calls).toEqual(['select:project-host', 'open']);
  let rendered = plain(workspace); expect(rendered).toContain('Native work ledger'); expect(rendered).toContain('work-stable');
  for (let i = 0; i < 10; i++) { handleAgentWorkspaceToken(workspace, { type: 'key', logicalName: 'pagedown' } as Parameters<typeof handleAgentWorkspaceToken>[1], () => {}, () => {}); rendered += plain(workspace); }
  expect(rendered).toContain('Verification: stale'); expect(rendered).toContain('attempt-stable'); expect(rendered).toContain('evidence-stable'); expect(rendered).toContain('commit-abc'); expect(rendered).toContain('Legacy operator work');
  workspace.close(); workspace.reopen(); expect(calls.slice(-2)).toEqual(['close', 'open']); workspace.close();
});
