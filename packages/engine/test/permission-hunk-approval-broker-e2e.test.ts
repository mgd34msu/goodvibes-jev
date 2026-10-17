import { useGateReadings } from './_helpers/gate-readings.ts';
import { describe, expect, test } from 'bun:test';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.js';
import type { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { ToolCall, ToolResult } from '../sdk/src/platform/types/tools.js';

useGateReadings();

/** Explicitly requested broker decisions retain the selected edit hunks through execution. */
function explicitBrokerPermissions(requestPermission: (request: Parameters<ApprovalBroker['requestApproval']>[0]['request']) => Promise<import('../sdk/src/platform/permissions/prompt.js').PermissionPromptDecision>): ToolExecutionDeps['permissionManager'] {
  return {
    async checkDetailed(tool: string, args: Record<string, unknown>) {
      const analysis = { classification: 'write' as const, riskLevel: 'medium' as const, summary: 'Explicit edit review', reasons: [] };
      const decision = await requestPermission({ callId: 'explicit-edit-review', tool, args, category: 'write', analysis });
      return { ...decision, persisted: false, sourceLayer: 'user_prompt', reasonCode: decision.approved ? 'user_approved' : 'user_denied', analysis };
    },
  } as unknown as ToolExecutionDeps['permissionManager'];
}

describe('Explicit ApprovalBroker -> executeToolCalls edit selection', () => {
  test('deselecting one of two hunks executes only the selected hunk, not both', async () => {
    const approvalBroker = new ApprovalBroker({ storePath: ':memory:' });

    const firstEdit = { path: 'a.ts', find: 'foo', replace: 'FOO' };
    const secondEdit = { path: 'a.ts', find: 'bar', replace: 'BAR' };
    const originalArgs = { edits: [firstEdit, secondEdit] };
    // Mirrors hunk-selection.ts's buildModifiedEditArgs: only the selected
    // hunk (index 0) survives; index 1 was deselected by the user.
    const modifiedArgs = { edits: [firstEdit] };

    // Simulates the TUI's real permissionPromptRef.requestPermission: the user
    // pressed Space to deselect hunk 2, then Enter to apply the remaining selection.
    const localPrompt = async () => ({ approved: true, remember: false, modifiedArgs });

    const requestPermission = (request: Parameters<typeof approvalBroker.requestApproval>[0]['request']) =>
      approvalBroker.requestApproval({ request, sessionId: 'sess-1', localPrompt });

    const permissionManager = explicitBrokerPermissions(requestPermission);

    let receivedArgs: Record<string, unknown> | undefined;
    const toolRegistry = {
      execute: async (callId: string, _name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        receivedArgs = args;
        return { callId, success: true, output: 'ok' };
      },
    } as unknown as ToolRegistry;

    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager,
      hookDispatcher: null,
      runtimeBus: null,
      sessionId: 'sess-1',
      emitterContext: (turnId: string) => ({ sessionId: 'sess-1', traceId: 'trace-1', turnId, source: 'orchestrator' }),
    };

    const call: ToolCall = { id: 'call-1', name: 'edit', arguments: originalArgs };
    const results = await executeToolCalls(deps, 'turn-1', [call]);

    expect(results[0]?.success).toBe(true);
    // The bug: this used to equal originalArgs (both hunks) because
    // ApprovalBroker dropped modifiedArgs on the way from the local prompt
    // decision to the resolved PermissionPromptDecision.
    expect(receivedArgs).toEqual(modifiedArgs);
    expect(receivedArgs).not.toEqual(originalArgs);
    expect((receivedArgs?.['edits'] as unknown[])?.length).toBe(1);
  });

  test('with no localPrompt-side filtering, both hunks still execute (control case)', async () => {
    const approvalBroker = new ApprovalBroker({ storePath: ':memory:' });
    const originalArgs = {
      edits: [
        { path: 'a.ts', find: 'foo', replace: 'FOO' },
        { path: 'a.ts', find: 'bar', replace: 'BAR' },
      ],
    };

    // Bare "Y" allow-once: no modifiedArgs at all, both hunks should execute.
    const localPrompt = async () => ({ approved: true, remember: false });
    const requestPermission = (request: Parameters<typeof approvalBroker.requestApproval>[0]['request']) =>
      approvalBroker.requestApproval({ request, sessionId: 'sess-1', localPrompt });

    const permissionManager = explicitBrokerPermissions(requestPermission);

    let receivedArgs: Record<string, unknown> | undefined;
    const toolRegistry = {
      execute: async (callId: string, _name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        receivedArgs = args;
        return { callId, success: true, output: 'ok' };
      },
    } as unknown as ToolRegistry;

    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager,
      hookDispatcher: null,
      runtimeBus: null,
      sessionId: 'sess-1',
      emitterContext: (turnId: string) => ({ sessionId: 'sess-1', traceId: 'trace-1', turnId, source: 'orchestrator' }),
    };

    const call: ToolCall = { id: 'call-2', name: 'edit', arguments: originalArgs };
    await executeToolCalls(deps, 'turn-1', [call]);

    expect(receivedArgs).toEqual(originalArgs);
  });
});
