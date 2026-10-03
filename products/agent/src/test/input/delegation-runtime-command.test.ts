import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDelegationRuntimeCommands } from '../../input/commands/delegation-runtime.ts';

describe('delegation runtime command', () => {
  test('submits structured handoff metadata through the shared-session route', async () => {
    const printed: string[] = [];
    const ensureCalls: Record<string, unknown>[] = [];
    const submitCalls: Record<string, unknown>[] = [];
    const registry = new CommandRegistry();
    registerDelegationRuntimeCommands(registry);

    const ctx = {
      print: (line: string) => {
        printed.push(line);
      },
      session: { runtime: { sessionId: 'agent-session-1' } },
      clients: {
        operator: {
          sessions: {
            ensureSession: async (input: Record<string, unknown>) => {
              ensureCalls.push(input);
              return { id: 'shared-session-1' };
            },
            submitMessage: async (input: Record<string, unknown>) => {
              submitCalls.push(input);
              return { id: 'submission-1' };
            },
          },
        },
      },
    } as unknown as CommandContext;

    const executed = await registry.execute('delegate', [
      '--review',
      '--reason',
      'Needs isolated verification',
      '--success',
      'Diff and test output',
      '--workspace',
      'release worktree',
      '--priority',
      'today',
      'Fix release blocker',
    ], ctx);

    expect(executed).toBe(true);
    expect(ensureCalls[0]?.metadata).toMatchObject({
      originSurface: 'goodvibes-agent',
      sourceSessionId: 'agent-session-1',
      task: 'Fix release blocker',
      reviewRequested: true,
      delegationReason: 'Needs isolated verification',
      successCriteria: 'Diff and test output',
      workspaceHint: 'release worktree',
      priority: 'today',
    });
    expect(submitCalls[0]?.metadata).toMatchObject({
      kind: 'task',
      task: 'Fix release blocker',
      reviewRequested: true,
      successCriteria: 'Diff and test output',
    });
    expect(String(submitCalls[0]?.body)).toContain('Delegation reason\nNeeds isolated verification');
    expect(String(submitCalls[0]?.body)).toContain('Success criteria or expected evidence\nDiff and test output');
    expect(String(submitCalls[0]?.body)).toContain('Delegated review was explicitly requested');
    expect(printed.join('\n')).toContain('Delegation submitted to GoodVibes TUI/shared-session routes.');
    expect(printed.join('\n')).toContain('reason Needs isolated verification');
  });
});
