/**
 * session-modes.test.ts
 *
 * The four session permission modes (plan / normal / accept-edits / auto) as
 * first-class policy sets: the allow/refuse matrix at both the layered
 * evaluator and the authoritative PermissionManager, the structured plan-mode
 * denial, the mode-change runtime event, and the plan-mode standing
 * instruction (injected + survives compaction).
 */
import { useGateReadings } from './_helpers/gate-readings.ts';
import { describe, expect, test } from 'bun:test';
import { LayeredPolicyEvaluator } from '../sdk/src/platform/runtime/permissions/evaluator.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema.js';
import { buildToolDenial, buildDenialErrorMessage, PLAN_MODE_DENIAL_REASON } from '../sdk/src/platform/permissions/denial.js';
import { bindPermissionModeChangeEvent } from '../sdk/src/platform/permissions/mode-change-emitter.js';
import type { ConfigManager, ConfigChangeCallback } from '../sdk/src/platform/config/manager.js';
import type { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import {
  appendPlanModeInstruction,
  PLAN_MODE_INSTRUCTION_MARKER,
} from '../sdk/src/platform/permissions/plan-mode-instructions.js';
import { buildReinjectedInstructions } from '../sdk/src/platform/core/compaction-sections.js';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A minimal RuntimeEventBus whose emit() records (channel, payload) into the
 * supplied sink. The double-cast through the emit shape is the repo's standard
 * bus-fixture bridge (see makeRuntimeBus in the plugins observability test),
 * a typed factory, not an `any` suppression.
 */
function makeCapturingBus(sink: Array<{ channel: string; payload: unknown }>): RuntimeEventBus {
  return {
    emit(channel: string, env: { payload: unknown }) {
      sink.push({ channel, payload: env.payload });
    },
  } as unknown as RuntimeEventBus;
}

function makeConfigReader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/session-modes-tests',
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

/** Build a manager and record whether the user was prompted (i.e. the mode "asked"). */
function makeManager(mode: PermissionMode, promptApproves = false) {
  const prompts: string[] = [];
  const manager = new PermissionManager(
    async ({ tool }) => { prompts.push(tool); return { approved: promptApproves, remember: false }; },
    makeConfigReader(mode),
    makePolicyRuntimeState(),
    null,
    null,
  );
  return { manager, prompts };
}

// ── evaluator mode matrix ────────────────────────────────────────────────────

describe('LayeredPolicyEvaluator mode matrix', () => {
  // The classification is what the gate's Jev reading says the call does
  // (gate/reading.ts classificationFromReading); the evaluator no longer
  // guesses it from the tool name.
  test('plan mode allows reads and denies write/exec/delegate', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'plan' });
    expect(e.evaluate('read', { path: 'a.ts' }, 'read').allowed).toBe(true);
    expect(e.evaluate('write', { path: 'a.ts' }, 'write').allowed).toBe(false);
    expect(e.evaluate('write', { path: 'a.ts' }, 'write').reason).toBe('MODE_DENY_PLAN');
    expect(e.evaluate('exec', { command: 'ls' }, 'read').allowed).toBe(true); // a read-only command reads
    expect(e.evaluate('exec', { command: 'rm x' }, 'destructive').allowed).toBe(false);
    expect(e.evaluate('agent', {}, 'escalation').allowed).toBe(false);
  });

  test('accept-edits auto-approves the engine file tools but still gates exec', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'accept-edits', defaultEffect: 'deny' });
    const w = e.evaluate('write', { path: 'a.ts' }, 'write');
    expect(w.allowed).toBe(true);
    expect(w.reason).toBe('MODE_ALLOW_ACCEPT_EDITS');
    expect(e.evaluate('edit', { path: 'a.ts' }, 'write').allowed).toBe(true);
    // A shell command that writes is not one of the engine's file tools.
    expect(e.evaluate('exec', { command: 'rm x' }, 'write').allowed).toBe(false);
  });

  test('allow-all approves everything; default gates writes', () => {
    expect(new LayeredPolicyEvaluator({ mode: 'allow-all' }).evaluate('exec', { command: 'x' }, 'write').allowed).toBe(true);
    const def = new LayeredPolicyEvaluator({ mode: 'default', defaultEffect: 'deny' });
    expect(def.evaluate('read', {}, 'read').allowed).toBe(true);
    expect(def.evaluate('write', { path: 'a' }, 'write').allowed).toBe(false);
  });

  test('a call named like no built-in tool is classified by its reading, not its name', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'plan' });
    expect(e.evaluate('curl', { url: 'https://example.com' }, 'read').allowed).toBe(true);
    expect(e.evaluate('notes_sync', { text: 'x' }, 'network').allowed).toBe(false);
  });
});

// ── PermissionManager mode matrix (authoritative path) ───────────────────────

describe('configured permission modes', () => {
  const readings = useGateReadings();
  test.each(['prompt', 'accept-edits', 'allow-all'] as const)('%s runs authorized calls without a secondary approval gate', async mode => {
    const { manager, prompts } = makeManager(mode);
    for (const tool of ['read', 'write', 'edit', 'agent', 'exec', 'goodvibes_settings']) {
      const result = await manager.checkDetailed(tool, { path: 'a', task: 'x', command: 'synthetic command' });
      expect(result).toMatchObject({ approved: true, reasonCode: 'config_allow' });
    }
    expect(prompts).toEqual([]);
    expect(readings.requests).toEqual([]);
  });
  test('plan mode allows read tools and structurally refuses effectful tools', async () => {
    const { manager, prompts } = makeManager('plan');
    expect((await manager.checkDetailed('read', { path: 'a' })).approved).toBe(true);
    for (const tool of ['write', 'edit', 'agent', 'exec']) {
      expect(await manager.checkDetailed(tool, { path: 'a', task: 'x', command: 'ls' }))
        .toMatchObject({ approved: false, reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    }
    expect(prompts).toEqual([]);
    expect(readings.requests).toEqual([]);
  });
  test('getMode reflects the setting and getPreset names its preset', () => {
    expect(makeManager('plan').manager.getMode()).toBe('plan');
    expect(makeManager('allow-all').manager.getPreset().name).toBe('auto');
    expect(makeManager('prompt').manager.getPreset().name).toBe('normal');
  });
});

// ── structured plan-mode denial ──────────────────────────────────────────────

describe('structured plan-mode denial', () => {
  test('plan_mode reason code surfaces ToolDenial reason "plan-mode" + steering', () => {
    const denial = buildToolDenial({ reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(denial).toEqual({ denied: true, reason: PLAN_MODE_DENIAL_REASON, scope: 'runtime_mode' });
    expect(PLAN_MODE_DENIAL_REASON).toBe('plan-mode');
    const msg = buildDenialErrorMessage('exec', { reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(msg).toContain('plan mode');
    expect(msg.toLowerCase()).toContain('present a');
  });

  test('non-plan denials pass their reason code through unchanged', () => {
    const denial = buildToolDenial({ reasonCode: 'user_denied', sourceLayer: 'user_prompt' });
    expect(denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt' });
  });
});

// ── mode-change runtime event ────────────────────────────────────────────────

describe('permission mode-change event', () => {
  test('bindPermissionModeChangeEvent emits the gate PRESET_CHANGED event on real transitions', () => {
    let listener: ConfigChangeCallback<'permissions.mode'> | null = null;
    const configManager: Pick<ConfigManager, 'subscribe'> = {
      subscribe: (_key, cb) => {
        listener = cb as unknown as ConfigChangeCallback<'permissions.mode'>;
        return () => {};
      },
    };
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const bus = makeCapturingBus(emitted);

    const unsub = bindPermissionModeChangeEvent(configManager, bus, 'sess-1');
    expect(typeof listener).toBe('function');

    listener!('plan', 'prompt');
    listener!('plan', 'plan'); // no-op transition, must not emit

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.channel).toBe('gate');
    expect(emitted[0]!.payload).toMatchObject({ type: 'PRESET_CHANGED', mode: 'plan', previousMode: 'prompt', preset: 'plan', previousPreset: 'normal' });
    unsub();
  });
});

// ── plan-mode instruction: injected + survives compaction ────────────────────

describe('plan-mode standing instruction', () => {
  test('appended to the system prompt only while plan mode is active', () => {
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain('BASE');
    expect(appendPlanModeInstruction('BASE', 'prompt')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'accept-edits')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'allow-all')).toBe('BASE');
  });

  test('survives compaction: the instruction chain is re-injected verbatim', () => {
    // getSystemPrompt() (with plan instruction appended) is the instruction
    // chain compaction re-injects, so the plan instruction rides through.
    const chain = appendPlanModeInstruction('SYSTEM PROMPT', 'plan');
    const section = buildReinjectedInstructions(chain, undefined);
    expect(section).not.toBeNull();
    expect(section!.content).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(section!.id).toBe('reinjected-instructions');
  });
});
