/**
 * The policy-explain surface (security action:"explain") must display the
 * SAME approval posture as cli/status.ts and the footer, computed via the
 * shared helper (src/permissions/approval-posture.ts), not re-derived
 * locally. This is one of the four surfaces named in the A2 brief.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader, forgetReadSecrets } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { forgetCatastrophicReadings } from '@goodvibes-jev/engine/sdk/platform/gate';
import { PolicyRuntimeState } from '../../runtime/index.ts';
import { approvalPostureReadings, POSTURE_CALLS } from '../helpers/approval-posture-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
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

    // A configured allowance cannot certify a particular call before its gate runs.
    const permissionLayer = (resolved.explanation.policyLayers as readonly { layer: string; outcome: string }[])
      .find((layer) => layer.layer === 'Permission mode');
    expect(permissionLayer?.outcome).toBe('unknown');
    expect(resolved.explanation.status).toBe('held');
  });

  test('default posture: a write is unevaluated while posture says Ask before powerful actions', () => {
    const context = fakeContext({ 'behavior.autoApprove': false, 'permissions.mode': 'prompt' });
    const resolved = explainAgentPolicyDecision(context, registryWithWriteTool(), { toolName: 'write' });

    expect(resolved.status).toBe('found');
    if (resolved.status !== 'found') return;
    const posture = resolved.explanation.posture as { label: string; bypassesPrompts: boolean };
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label).toBe('Ask before powerful actions');
    expect(resolved.explanation.status).toBe('held');
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

  test('plan mode: configuration is observable without predicting an unexamined write', () => {
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
    expect(permissionLayer?.outcome).toBe('unknown');
    expect(resolved.explanation.status).toBe('held');
  });

  test('accept-edits mode: scoped allowance does not predict approval of an unexamined write', () => {
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
    expect(permissionLayer?.outcome).toBe('unknown');
    expect(resolved.explanation.status).toBe('held');
  });
});


describe('policy explain never substitutes configuration for a live gate decision', () => {
  let config: ConfigManager;
  let fixture: ReturnType<typeof approvalPostureReadings>;
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let prompts: string[];
  let executions: string[];
  let manager: PermissionManager;
  const toolKeys = ['read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze', 'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp'] as const;
  const allAllow = Object.fromEntries(toolKeys.map((tool) => [tool, 'allow'])) as Record<string, 'allow'>;

  beforeEach(() => {
    forgetReadSecrets();
    forgetCatastrophicReadings();
    fixture = approvalPostureReadings();
    previousPort = installJudgmentPort(fixture.port);
    config = new ConfigManager({ surfaceRoot: 'tui', configDir: makeProjectTempDir('gv-explain-gate-') });
    resetSettingsControlPlaneStore(config);
    prompts = [];
    executions = [];
    manager = new PermissionManager(async (request) => {
      prompts.push(request.tool);
      return { approved: false, remember: false };
    }, createPermissionConfigReader(config), new PolicyRuntimeState());
  });
  afterEach(() => {
    installJudgmentPort(previousPort);
    forgetReadSecrets();
    forgetCatastrophicReadings();
    resetSettingsControlPlaneStore(config);
  });

  const cases: readonly {
    name: string;
    mode: 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits';
    autoApprove?: boolean;
    tools?: Record<string, 'allow' | 'deny' | 'prompt'>;
    call: keyof typeof POSTURE_CALLS;
    approved: boolean;
    reason: Awaited<ReturnType<PermissionManager['checkDetailed']>>['reasonCode'];
  }[] = [
    { name: 'critical shell in allow-all', mode: 'allow-all', call: 'critical', approved: false, reason: 'user_denied' },
    { name: 'catastrophic shell with autoApprove', mode: 'prompt', autoApprove: true, call: 'catastrophic', approved: false, reason: 'boundary_catastrophic' },
    { name: 'catastrophic shell in allow-all', mode: 'allow-all', call: 'catastrophic', approved: false, reason: 'boundary_catastrophic' },
    { name: 'catastrophic shell with all custom rules allowing', mode: 'custom', tools: allAllow, call: 'catastrophic', approved: false, reason: 'boundary_catastrophic' },
    { name: 'secret read in prompt mode', mode: 'prompt', call: 'secretRead', approved: false, reason: 'user_denied' },
    { name: 'secret read in plan mode', mode: 'plan', call: 'secretRead', approved: false, reason: 'user_denied' },
    { name: 'critical file action in accept-edits', mode: 'accept-edits', call: 'criticalEdit', approved: false, reason: 'user_denied' },
    { name: 'ordinary write with autoApprove', mode: 'prompt', autoApprove: true, call: 'write', approved: true, reason: 'config_allow' },
    { name: 'ordinary read in prompt mode', mode: 'prompt', call: 'read', approved: true, reason: 'config_allow' },
    { name: 'ordinary write in prompt mode', mode: 'prompt', call: 'write', approved: false, reason: 'user_denied' },
    { name: 'file edit in accept-edits', mode: 'accept-edits', call: 'write', approved: true, reason: 'preset_allow' },
    { name: 'read-only shell in plan mode', mode: 'plan', call: 'readOnlyExec', approved: true, reason: 'preset_allow' },
    { name: 'read-only shell in prompt mode', mode: 'prompt', call: 'readOnlyExec', approved: true, reason: 'preset_allow' },
    { name: 'unknown read-only tool in custom mode', mode: 'custom', call: 'unknownRead', approved: true, reason: 'preset_allow' },
    { name: 'read with explicit custom allow', mode: 'custom', tools: { read: 'allow' }, call: 'secretRead', approved: true, reason: 'config_allow' },
    { name: 'read with explicit custom deny', mode: 'custom', tools: { read: 'deny' }, call: 'read', approved: false, reason: 'config_deny' },
    { name: 'read with explicit custom prompt', mode: 'custom', tools: { read: 'prompt' }, call: 'read', approved: false, reason: 'user_denied' },
  ];

  for (const scenario of cases) {
    test(`${scenario.name}: JSON remains held until the real gate evaluates`, async () => {
      const values: Record<string, unknown> = { 'permissions.mode': scenario.mode, 'behavior.autoApprove': scenario.autoApprove === true };
      for (const [key, action] of Object.entries(scenario.tools ?? {})) values[`permissions.tools.${key}`] = action;
      for (const [key, value] of Object.entries(values)) config.set(key as 'permissions.mode', value as never);
      const call = POSTURE_CALLS[scenario.call];
      const registry = new ToolRegistry();
      registry.register({
        definition: { name: call.tool, description: 'Synthetic gate fixture', parameters: { type: 'object', additionalProperties: true } },
        execute: async () => { executions.push(call.tool); return { success: true, output: '' }; },
      });
      const result = explainAgentPolicyDecision(fakeContext(values), registry, { toolName: call.tool, toolArgs: call.args });
      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('Expected an explanation');
      // Serialization is part of the consumer-facing contract, not just prose.
      const body = JSON.parse(JSON.stringify(result.explanation));
      expect(fixture.requests).toHaveLength(0);
      expect(prompts).toHaveLength(0);
      expect(executions).toHaveLength(0);
      const actual = await manager.checkDetailed(call.tool, call.args);
      expect(actual.approved).toBe(scenario.approved);
      expect(actual.reasonCode).toBe(scenario.reason);
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(executions).toHaveLength(0);
      expect(body.status).toBe('held');
      expect(body.preflight).toMatchObject({ approvedWithoutMoreInput: false, permissionOutcome: 'unknown', permissionEvaluated: false });
      expect(body.policyLayers.find((layer: { layer: string }) => layer.layer === 'Permission mode')).toMatchObject({
        outcome: 'unknown', sourceLayer: 'not_evaluated', reasonCode: 'live_check_required', mode: scenario.mode,
      });
      expect(body.requiredActions.join(' ')).not.toContain('Answer the');
      if (scenario.tools?.[call.tool]) {
        expect(body.policyLayers.find((layer: { layer: string }) => layer.layer === 'Permission mode').configuredAction).toBe(scenario.tools[call.tool]);
      }
    });
  }
});
