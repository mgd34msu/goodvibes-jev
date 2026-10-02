/**
 * The policy-explain surface (security action:"explain") must display the
 * SAME approval posture as cli/status.ts and the footer, computed via the
 * shared helper (src/permissions/approval-posture.ts), not re-derived
 * locally. This is one of the four surfaces named in the A2 brief.
 */
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { explainAgentPolicyDecision } from '../../tools/agent-policy-explanation.ts';
import { computeApprovalPosture } from '../../permissions/approval-posture.ts';

function fakeContext(values: Record<string, unknown>): CommandContext {
  return {
    workspace: {},
    platform: {
      config: {
        behavior: { autoApprove: values['behavior.autoApprove'] === true },
        permissions: { mode: values['permissions.mode'] ?? 'prompt', tools: {} },
      },
      configManager: {
        get: (key: string) => values[key],
      },
    },
    session: { runtime: {} },
  } as CommandContext;
}

function registryWithWriteTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: 'write',
      description: 'Write a file',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async () => ({ success: true, output: '' }),
  });
  return registry;
}

describe('agent-policy-explanation: approval posture agreement', () => {
  test('autoApprove=true, mode=prompt (the reproduced A2 bug): explanation posture honestly says auto-approve is on', () => {
    const context = fakeContext({ 'behavior.autoApprove': true, 'permissions.mode': 'prompt' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; autoApprove: boolean; automaticApprovals: boolean; bypassesPrompts: boolean; detail: string; mode: string };
    expect(posture.autoApprove).toBe(true);
    expect(posture.automaticApprovals).toBe(true);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.detail).toContain('Boundary checks still apply');
    expect(posture.label.toLowerCase()).toContain('auto-approve');

    // Must match the shared helper's output exactly, not a locally-worded approximation.
    const expected = computeApprovalPosture({ autoApprove: true, mode: 'prompt' });
    expect(posture.label).toBe(expected.label);

    // The tool-level prediction agrees: write is allowed without a prompt.
    const permissionLayer = (resolved.explanation.policyLayers as readonly { layer: string; outcome: string }[])
      .find((layer) => layer.layer === 'Permission mode');
    expect(permissionLayer?.outcome).toBe('allowed');
    expect(resolved.explanation.status).toBe('allowed');
  });

  test('default posture: autoApprove=false, mode=prompt: write requires confirmation and posture says Ask before powerful actions', () => {
    const context = fakeContext({ 'behavior.autoApprove': false, 'permissions.mode': 'prompt' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; bypassesPrompts: boolean };
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label).toBe('Ask before powerful actions');
    expect(resolved.explanation.status).toBe('confirmation_required');
  });

  test('allow-all mode, autoApprove=false: posture exposes automatic approvals and the critical-stakes exception', () => {
    const context = fakeContext({ 'behavior.autoApprove': false, 'permissions.mode': 'allow-all' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; automaticApprovals: boolean; bypassesPrompts: boolean; detail: string; autoApprove: boolean };
    expect(posture.autoApprove).toBe(false);
    expect(posture.automaticApprovals).toBe(true);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.detail).toContain('Boundary checks still apply');
    expect(posture.label).toBe('Automatic below critical stakes');
    expect(posture.detail).toContain('critical calls still ask');
  });

  test('plan mode: write is predicted denied outright (plan_mode), never "prompt"', () => {
    const context = fakeContext({ 'behavior.autoApprove': false, 'permissions.mode': 'plan' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; automaticApprovals: boolean; bypassesPrompts: boolean; detail: string; mode: string };
    expect(posture.mode).toBe('plan');
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label.toLowerCase()).toContain('plan');

    const permissionLayer = (resolved.explanation.policyLayers as readonly { layer: string; outcome: string; reason?: string }[])
      .find((layer) => layer.layer === 'Permission mode');
    expect(permissionLayer?.outcome).toBe('denied');
    expect(resolved.explanation.status).toBe('denied');
  });

  test('accept-edits mode: write is predicted allowed (auto-approves), matching the shared helper', () => {
    const context = fakeContext({ 'behavior.autoApprove': false, 'permissions.mode': 'accept-edits' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; automaticApprovals: boolean; bypassesPrompts: boolean; detail: string; mode: string };
    expect(posture.mode).toBe('accept-edits');
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label.toLowerCase()).toContain('accept edits');

    const permissionLayer = (resolved.explanation.policyLayers as readonly { layer: string; outcome: string }[])
      .find((layer) => layer.layer === 'Permission mode');
    expect(permissionLayer?.outcome).toBe('allowed');
    expect(resolved.explanation.status).toBe('allowed');
  });
});
