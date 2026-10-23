/**
 * Configured approval posture versus the real public PermissionManager gate.
 * Explicit offline readings cover normal, critical, and boundary-refused calls.
 * Broad automatic approvals must remain visible without claiming a universal
 * prompt bypass. The real gate decides every result below.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader, forgetReadSecrets } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { computeApprovalPosture, readApprovalPostureFromConfig } from '../../permissions/approval-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetCatastrophicReadings } from '@goodvibes-jev/engine/sdk/platform/gate';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { approvalPostureReadings, POSTURE_CALLS } from '../helpers/approval-posture-readings.ts';

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

const SCENARIOS: readonly (Scenario & { readonly expectedWrite: 'allow' | 'prompt' | 'deny' })[] = [
  { name: 'default: prompt mode, autoApprove off', autoApprove: false, mode: 'prompt', expectedWrite: 'allow' },
  { name: 'autoApprove on, mode stays prompt (the exact reproduced A2 bug)', autoApprove: true, mode: 'prompt', expectedWrite: 'allow' },
  { name: 'autoApprove on, mode allow-all', autoApprove: true, mode: 'allow-all', expectedWrite: 'allow' },
  { name: 'autoApprove on, mode custom with every category denied', autoApprove: true, mode: 'custom', expectedWrite: 'deny', tools: allToolsAs('deny') },
  { name: 'allow-all mode, autoApprove off', autoApprove: false, mode: 'allow-all', expectedWrite: 'allow' },
  { name: 'custom mode, every category allow (broad automatic approvals)', autoApprove: false, mode: 'custom', expectedWrite: 'allow', tools: allToolsAs('allow') },
  { name: 'custom mode, write set to prompt (mixed, no broad automatic approvals)', autoApprove: false, mode: 'custom', expectedWrite: 'allow', tools: { ...allToolsAs('allow'), write: 'prompt' } },
  { name: 'custom mode, write set to deny (mixed, no broad automatic approvals)', autoApprove: false, mode: 'custom', expectedWrite: 'deny', tools: { ...allToolsAs('allow'), write: 'deny' } },
];

describe('approval posture: shared helper agrees with the real permission gate', () => {
  let configManager: ConfigManager;
  let policyRuntimeState: PolicyRuntimeState;
  let requests: PermissionPromptRequest[];
  let manager: PermissionManager;
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let readings: ReturnType<typeof approvalPostureReadings>;

  beforeEach(() => {
    forgetReadSecrets();
    forgetCatastrophicReadings();
    readings = approvalPostureReadings();
    previousPort = installJudgmentPort(readings.port);
    configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir: makeProjectTempDir(`gv-approval-posture-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    });
    resetSettingsControlPlaneStore(configManager);
    policyRuntimeState = new PolicyRuntimeState();
    requests = [];
    // The real gate still reads the exact call, enforces the boundary and
    // evaluates the active preset. Only judgment I/O is synthetic; no gate
    // method, decision, or optional policy evaluator is replaced.
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
    installJudgmentPort(previousPort);
    forgetReadSecrets();
    forgetCatastrophicReadings();
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
    test(`${scenario.name}: configured automatic approvals agree with the representative write gate`, async () => {
      applyScenario(scenario);
      requests.length = 0;

      const posture = readApprovalPostureFromConfig(configManager);
      const result = await manager.checkDetailed(POSTURE_CALLS.write.tool, POSTURE_CALLS.write.args);
      expect(result.reading).toBeUndefined();
      expect(readings.requests).toHaveLength(0);

      expect(posture.bypassesPrompts).toBe(false);
      expect(posture.automaticApprovals).toBe(scenario.expectedWrite === 'allow');
      if (scenario.expectedWrite === 'allow') {
        expect(result.sourceLayer).not.toBe('user_prompt');
        expect(requests).toHaveLength(0);
        expect(result.approved).toBe(true);
      } else if (scenario.expectedWrite === 'deny') {
        expect(result.reasonCode).toBe('config_deny');
        expect(result.approved).toBe(false);
        expect(requests).toHaveLength(0);
      } else {
        expect(result.sourceLayer).toBe('user_prompt');
        expect(result.approved).toBe(false);
        expect(requests).toHaveLength(1);
      }
    });
  }

  test('the exact reproduced A2 bug: autoApprove=true with mode=prompt automatically approves representative calls in every category', async () => {
    configManager.set('behavior.autoApprove', true);
    configManager.set('permissions.mode', 'prompt');

    const posture = readApprovalPostureFromConfig(configManager);
    expect(posture.autoApprove).toBe(true);
    expect(posture.automaticApprovals).toBe(true);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label).toContain('Auto-approve ON');

    for (const tool of ['read', 'write', 'exec', 'agent'] as const) {
      requests.length = 0;
      const result = await manager.checkDetailed(POSTURE_CALLS[tool].tool, POSTURE_CALLS[tool].args);
      expect(result.approved).toBe(true);
      expect(result.sourceLayer).not.toBe('user_prompt');
      expect(requests).toHaveLength(0);
    }
  });

  test.each(['critical', 'outwardUncertain', 'catastrophic'] as const)('configured calls do not gain an implicit semantic approval gate: %s', async kind => {
    for (const scenario of SCENARIOS) {
      applyScenario(scenario); requests.length = 0;
      const call = POSTURE_CALLS[kind];
      const result = await manager.checkDetailed(call.tool, call.args);
      const denied = scenario.mode === 'custom' && scenario.tools?.[call.tool as (typeof PERMISSION_TOOL_KEYS)[number]] === 'deny';
      expect(result.approved).toBe(!denied);
      expect(requests).toHaveLength(0); expect(readings.requests).toHaveLength(0);
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
      expect(posture.automaticApprovals).toBe(mode !== 'custom');
      expect(posture.bypassesPrompts).toBe(false);
      expect(posture.label.toLowerCase()).toContain('auto-approve');
    }
  });

  test('the footer danger indicator uses configured automatic approvals, not the universal bypass flag', async () => {
    for (const scenario of SCENARIOS) {
      applyScenario(scenario);
      const posture = readApprovalPostureFromConfig(configManager);
      expect(posture.automaticApprovals).toBe(scenario.expectedWrite === 'allow');
      const footer = buildShellFooter({
        width: 120, promptText: '', promptLineCount: 1, usage: { up: 0, down: 0 },
        showExitNotice: false, lastCopyTime: 0, runningAgentCount: 0,
        runningProcessCount: 0, indicatorFocused: false,
        dangerMode: posture.automaticApprovals,
      });
      const text = footer.lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(text.includes('! auto-approve')).toBe(scenario.expectedWrite === 'allow');
    }
  });

  test('mode details describe the native policy and retained authority boundaries', () => {
    for (const mode of ['prompt', 'allow-all', 'custom', 'plan', 'accept-edits'] as const) {
      const posture = computeApprovalPosture({ autoApprove: false, mode });
      expect(posture.detail).toContain(`permissions.mode is ${mode}`);
      expect(posture.detail).toContain('Calls require current invocation authority');
      expect(posture.detail).toContain('Configured denials');
      expect(posture.bypassesPrompts).toBe(false);
    }
  });

  // The plan/accept-edits modes are excluded from the shared SCENARIOS loop
  // above: that loop exercises a representative write and distinguishes automatic approval from
  // "reaches the user prompt or an explicit config_deny", but plan mode
  // introduces a THIRD outcome (refused outright, via reasonCode 'plan_mode',
  // never asked and never a custom-config deny) and accept-edits mode splits
  // outcomes by category (write auto-approves, execute still asks). Both get
  // dedicated tests instead of being forced into that generalization.

  test('plan mode: ordinary reads auto-allow; representative mutating calls are refused outright, never asked', async () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'plan');

    const posture = readApprovalPostureFromConfig(configManager);
    expect(posture.kind).toBe('plan');
    expect(posture.mode).toBe('plan');
    expect(posture.autoApprove).toBe(false);
    expect(posture.bypassesPrompts).toBe(false);
    expect(posture.label.toLowerCase()).toContain('plan');

    requests.length = 0;
    const readResult = await manager.checkDetailed(POSTURE_CALLS.read.tool, POSTURE_CALLS.read.args);
    expect(readResult.approved).toBe(true);
    expect(requests).toHaveLength(0);

    for (const tool of ['write', 'exec', 'agent'] as const) {
      requests.length = 0;
      const result = await manager.checkDetailed(POSTURE_CALLS[tool].tool, POSTURE_CALLS[tool].args);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('plan_mode');
      expect(result.sourceLayer).not.toBe('user_prompt');
      // Refused, not asked, the model must present a plan instead of acting.
      expect(requests).toHaveLength(0);
    }
  });

  test('accept-edits mode permits configured reads, writes and commands automatically', async () => {
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
      const result = await manager.checkDetailed(POSTURE_CALLS[tool].tool, POSTURE_CALLS[tool].args);
      expect(result.approved).toBe(true);
      expect(requests).toHaveLength(0);
    }

    requests.length = 0;
    const execResult = await manager.checkDetailed(POSTURE_CALLS.exec.tool, POSTURE_CALLS.exec.args);
    expect(requests).toHaveLength(0);
    expect(execResult.sourceLayer).toBe('config_policy');
    expect(execResult.approved).toBe(true);
  });
});
