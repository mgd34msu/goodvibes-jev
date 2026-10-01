/**
 * Approval posture agreement: the shared helper (src/permissions/approval-posture.ts)
 * vs the real permission gate (SDK PermissionManager.checkDetailed()).
 *
 * The A2 defect was a DISPLAY disagreement: cli/status.ts derived a posture
 * label from permissions.mode alone, ignoring behavior.autoApprove, while the
 * gate checks autoApprove FIRST. These tests drive a REAL PermissionManager
 * (not a re-implementation) across the full (autoApprove x mode) matrix and
 * assert that computeApprovalPosture's bypassesPrompts flag never disagrees
 * with what the gate actually does for a representative write-category tool.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { computeApprovalPosture, readApprovalPostureFromConfig } from '../../permissions/approval-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ToolAction = 'allow' | 'prompt' | 'deny';
const PERMISSION_TOOL_KEYS = [
  'read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze',
  'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp',
] as const;

function allToolsAs(action: ToolAction): Record<(typeof PERMISSION_TOOL_KEYS)[number], ToolAction> {
  return Object.fromEntries(PERMISSION_TOOL_KEYS.map((key) => [key, action])) as Record<(typeof PERMISSION_TOOL_KEYS)[number], ToolAction>;
}

interface Scenario {
  readonly name: string;
  readonly autoApprove: boolean;
  readonly mode: 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits';
  readonly tools?: Partial<Record<(typeof PERMISSION_TOOL_KEYS)[number], ToolAction>>;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'default: prompt mode, autoApprove off', autoApprove: false, mode: 'prompt' },
  { name: 'autoApprove on, mode stays prompt (the exact reproduced A2 bug)', autoApprove: true, mode: 'prompt' },
  { name: 'autoApprove on, mode allow-all', autoApprove: true, mode: 'allow-all' },
  { name: 'autoApprove on, mode custom with every category denied', autoApprove: true, mode: 'custom', tools: allToolsAs('deny') },
  { name: 'allow-all mode, autoApprove off', autoApprove: false, mode: 'allow-all' },
  { name: 'custom mode, every category allow (full bypass)', autoApprove: false, mode: 'custom', tools: allToolsAs('allow') },
  { name: 'custom mode, write set to prompt (mixed, not a full bypass)', autoApprove: false, mode: 'custom', tools: { ...allToolsAs('allow'), write: 'prompt' } },
  { name: 'custom mode, write set to deny (mixed, not a full bypass)', autoApprove: false, mode: 'custom', tools: { ...allToolsAs('allow'), write: 'deny' } },
];

describe('approval posture: shared helper agrees with the real permission gate', () => {
  let configManager: ConfigManager;
  let policyRuntimeState: PolicyRuntimeState;
  let requests: PermissionPromptRequest[];
  let manager: PermissionManager;

  beforeEach(() => {
    configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: makeProjectTempDir(`gv-approval-posture-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    });
    resetSettingsControlPlaneStore(configManager);
    policyRuntimeState = new PolicyRuntimeState();
    requests = [];
    // No featureFlags, this exercises the raw documented precedence
    // (autoApprove -> allow-all -> custom -> prompt-mode-reads-auto-allow)
    // that computeApprovalPosture mirrors, not the optional policy engine.
    manager = new PermissionManager(
      async (request) => {
        requests.push(request);
        return { approved: false, remember: false };
      },
      createPermissionConfigReader(configManager),
      policyRuntimeState,
    );
  });

  afterEach(() => {
    resetSettingsControlPlaneStore(configManager);
  });

  function applyScenario(scenario: Scenario): void {
    configManager.set('behavior.autoApprove', scenario.autoApprove);
    configManager.set('permissions.mode', scenario.mode);
    if (scenario.tools) {
      for (const [key, action] of Object.entries(scenario.tools)) {
        configManager.set(`permissions.tools.${key}` as 'permissions.tools.read', action as never);
      }
    }
  }

  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: bypassesPrompts agrees with checkDetailed() for the write tool`, async () => {
      applyScenario(scenario);
      requests.length = 0;

      const posture = readApprovalPostureFromConfig(configManager);
      const result = await manager.checkDetailed('write', { path: 'demo.ts' });

      if (posture.bypassesPrompts) {
        // The posture claims NOTHING ever prompts, the gate must resolve
        // without ever reaching the user-prompt step.
        expect(result.sourceLayer).not.toBe('user_prompt');
        expect(requests).toHaveLength(0);
        expect(result.approved).toBe(true);
      } else {
        // The posture claims tool calls CAN still be gated, the gate must
        // either reach the user-prompt step or explicitly deny via a
        // configured rule. It must never silently auto-approve behind the
        // posture's back.
        const reachedPromptOrExplicitDeny = result.sourceLayer === 'user_prompt' || result.reasonCode === 'config_deny';
        expect(reachedPromptOrExplicitDeny).toBe(true);
      }
    });
  }

  test('the exact reproduced A2 bug: autoApprove=true with mode=prompt bypasses every category, not just writes', async () => {
    configManager.set('behavior.autoApprove', true);
    configManager.set('permissions.mode', 'prompt');

    const posture = readApprovalPostureFromConfig(configManager);
    expect(posture.autoApprove).toBe(true);
    expect(posture.bypassesPrompts).toBe(true);
    expect(posture.label).toContain('Auto-approve ON');

    for (const tool of ['read', 'write', 'exec', 'agent'] as const) {
      requests.length = 0;
      const result = await manager.checkDetailed(tool, {});
      expect(result.approved).toBe(true);
      expect(result.sourceLayer).not.toBe('user_prompt');
      expect(requests).toHaveLength(0);
    }
  });

  test('computeApprovalPosture (pure) matches readApprovalPostureFromConfig (config-reading convenience) for every scenario', () => {
    for (const scenario of SCENARIOS) {
      applyScenario(scenario);
      const tools = configManager.getCategory('permissions').tools;
      const pure = computeApprovalPosture({
        autoApprove: scenario.autoApprove,
        mode: scenario.mode,
        customTools: { ...tools },
      });
      const fromConfig = readApprovalPostureFromConfig(configManager);
      expect(fromConfig).toEqual(pure);
    }
  });

  test('labels always name auto-approve explicitly when autoApprove is what is actually gating tool calls', () => {
    for (const mode of ['prompt', 'allow-all', 'custom'] as const) {
      const posture = computeApprovalPosture({ autoApprove: true, mode, customTools: allToolsAs('deny') });
      expect(posture.kind).toBe('auto-approve');
      expect(posture.bypassesPrompts).toBe(true);
      expect(posture.label.toLowerCase()).toContain('auto-approve');
    }
  });

  // The plan/accept-edits modes are excluded from the shared SCENARIOS loop
  // above: that loop's assertion only distinguishes "fully bypasses" from
  // "reaches the user prompt or an explicit config_deny", but plan mode
  // introduces a THIRD outcome (refused outright, via reasonCode 'plan_mode',
  // never asked and never a custom-config deny) and accept-edits mode splits
  // outcomes by category (write auto-approves, execute still asks). Both get
  // dedicated tests instead of being forced into that generalization.

  test('plan mode: read tools auto-allow; write/execute/delegate tools are refused outright, never asked', async () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'plan');

    const posture = readApprovalPostureFromConfig(configManager);
    expect(posture.kind).toBe('plan');
    expect(posture.mode).toBe('plan');
    expect(posture.autoApprove).toBe(false);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label.toLowerCase()).toContain('plan');

    requests.length = 0;
    const readResult = await manager.checkDetailed('read', {});
    expect(readResult.approved).toBe(true);
    expect(requests).toHaveLength(0);

    for (const tool of ['write', 'exec', 'agent'] as const) {
      requests.length = 0;
      const result = await manager.checkDetailed(tool, {});
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('plan_mode');
      expect(result.sourceLayer).not.toBe('user_prompt');
      // Refused, not asked, the model must present a plan instead of acting.
      expect(requests).toHaveLength(0);
    }
  });

  test('accept-edits mode: read/write tools auto-approve without asking; execute still asks', async () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'accept-edits');

    const posture = readApprovalPostureFromConfig(configManager);
    expect(posture.kind).toBe('accept-edits');
    expect(posture.mode).toBe('accept-edits');
    expect(posture.autoApprove).toBe(false);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label.toLowerCase()).toContain('accept edits');

    for (const tool of ['read', 'write'] as const) {
      requests.length = 0;
      const result = await manager.checkDetailed(tool, { path: 'demo.ts' });
      expect(result.approved).toBe(true);
      expect(requests).toHaveLength(0);
    }

    requests.length = 0;
    const execResult = await manager.checkDetailed('exec', {});
    // The mock requestPermission (beforeEach) always denies, proving this
    // reached the ask rather than silently auto-approving.
    expect(requests).toHaveLength(1);
    expect(execResult.sourceLayer).toBe('user_prompt');
    expect(execResult.approved).toBe(false);
  });
});
