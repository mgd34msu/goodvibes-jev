/**
 * sandbox-escalation-judgment.test.ts
 *
 * The per-command exec sandbox routes its host-access escalations through the
 * ONE approval broker (same request shape + attribution as a permission ask and
 * an MCP elicitation), and the Jev advisory tier (engine.gate.sandbox-advisory)
 * annotates or (opt-in) auto-approves the residual ask WITHOUT ever converting
 * allow to deny or touching the frozen catastrophic block. Pins: broker
 * attribution, approve/deny passthrough, annotate-only default, auto-approve
 * opt-in path only on a confident looks-safe reading, the allow-to-deny
 * invariant, an uncertain reading annotating, and a port failure surfacing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  createSandboxEscalationApprovalHandler,
  type EscalationApprovalRequester,
} from '../sdk/src/platform/runtime/permissions/sandbox-escalation.js';
import {
  applySandboxJudgment,
  runSandboxJudgment,
  type SandboxJudgmentResult,
  type SandboxJudgmentReceipt,
} from '../sdk/src/platform/runtime/permissions/sandbox-judgment.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.js';
import { detectSandboxAvailability, type ExecSandboxRuntime } from '../sdk/src/platform/tools/exec/sandbox.js';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.js';

// A requestApproval spy that records the request and returns a fixed decision.
function spyApproval(approved: boolean) {
  const seen: PermissionPromptRequest[] = [];
  const requester: EscalationApprovalRequester = async ({ request }) => {
    seen.push(request);
    return { approved };
  };
  return { requester, seen };
}

const ESC = ['wants-network'];
function req() {
  return {
    sandbox: 'exec-sandbox',
    command: 'curl https://example.com',
    escalations: ESC,
    boundary: 'bubblewrap: workspace writable, network disabled',
    policyReasons: ['runs inside the sandbox boundary but needs host access: wants-network'],
    workingDirectory: '/work',
  };
}

/** Installs a port whose sandbox-advisory reading has this risk probability; returns the request log. */
function readRisk(probability: number) {
  const { port, requests } = fakePort(() => noulAnswer(probability));
  installJudgmentPort(port);
  return requests;
}
const looksSafe = () => readRisk(0.04);
const flagsRisk = () => readRisk(0.96);
const uncertain = () => readRisk(0.5);
afterEach(() => { installJudgmentPort(undefined); });

// ── 3a: broker routing + attribution ─────────────────────────────────────────

describe('sandbox escalation → approval broker', () => {
  test('builds a broker request attributed to the sandbox + escalations', async () => {
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester);
    const outcome = await handler(req());
    expect(outcome.approved).toBe(true);
    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect(r.tool).toBe('exec');
    expect(r.category).toBe('execute');
    expect(r.attribution).toEqual({ kind: 'sandbox-escalation', sandbox: 'exec-sandbox', escalations: ESC });
    expect(r.analysis.classification).toBe('sandbox-escalation');
    expect(r.args).toEqual({ command: 'curl https://example.com' });
    expect(r.workingDirectory).toBe('/work');
  });

  test('a broker denial maps to not-approved', async () => {
    const { requester } = spyApproval(false);
    const handler = createSandboxEscalationApprovalHandler(requester);
    expect((await handler(req())).approved).toBe(false);
  });
});

// ── 3b: judgment tier, annotate-only default ────────────────────────────────

describe('sandbox judgment tier', () => {
  test('annotate-only default: looks-safe still asks the human, ask carries the annotation', async () => {
    looksSafe();
    const { requester, seen } = spyApproval(true);
    const receipts: SandboxJudgmentReceipt[] = [];
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: true, autoApprove: false },
      onReceipt: (r) => receipts.push(r),
    });
    const outcome = await handler(req());
    expect(seen).toHaveLength(1); // the human was still asked
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('Jev reading: looks safe'))).toBe(true);
    expect(outcome.judgmentReceipt?.outcome).toBe('annotated');
    expect(receipts[0]!.outcome).toBe('annotated');
  });

  test('auto-approve opt-in: a confident looks-safe reading auto-approves WITHOUT prompting', async () => {
    const requests = looksSafe();
    const { requester, seen } = spyApproval(false); // would deny if asked, proves we did NOT ask
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    expect(outcome.approved).toBe(true);
    expect(seen).toHaveLength(0); // auto-approved: no human prompt
    expect(outcome.judgmentReceipt?.outcome).toBe('auto-approved');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.state)).toContain('curl https://example.com');
  });

  test('allow-to-deny invariant: flags-risk NEVER auto-denies, even in auto-approve mode', async () => {
    flagsRisk();
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('Jev reading: flags a risk'))).toBe(true);
    expect(outcome.judgmentReceipt?.outcome).toBe('annotated');
    expect(outcome.approved).toBe(true); // the human's decision stands, not the reading's
  });

  test('an uncertain reading annotates and asks, even in auto-approve mode', async () => {
    uncertain();
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('cannot tell'))).toBe(true);
    expect(outcome.judgmentReceipt?.verdict).toBe('uncertain');
  });

  test('a missing judgment port surfaces as an error, never a silent pass', async () => {
    installJudgmentPort(undefined);
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: true, autoApprove: true },
    });
    await expect(handler(req())).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test('disabled tier does not read at all', async () => {
    const requests = looksSafe();
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      config: { enabled: false, autoApprove: true },
    });
    await handler(req());
    expect(requests).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
});

// ── exec-runtime wiring: a denied escalation blocks the command (no spawn) ───

describe('exec runtime raises the escalation through the injected seam', () => {
  // Fabricate an available sandbox WITHOUT a real bwrap spawn: a denied
  // escalation returns before any process is spawned, so the fake bwrap path is
  // never executed on any host.
  const availability = detectSandboxAvailability({
    platform: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapWorks: true, netUnshareWorks: true,
  });

  test('a command that wants network is denied when requestEscalation refuses', async () => {
    let asked: { command: string; escalations: readonly string[] } | null = null;
    const sandbox: ExecSandboxRuntime = {
      config: { enabled: true, egressAllowlist: [], workspaceWritable: [] },
      availability,
      featureEnabled: true,
      requestEscalation: async (input) => { asked = { command: input.command, escalations: input.escalations }; return false; },
    };
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: process.cwd() }),
      sandbox,
    });
    const result = await tool.execute({ working_dir: process.cwd(), commands: [{ cmd: 'curl https://example.com' }] });
    expect(asked).not.toBeNull();
    expect(asked!.escalations.length).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { commands?: Array<{ stderr?: string }>; stderr?: string };
    const cmd0 = output.commands?.[0] ?? output;
    expect(cmd0.stderr).toContain('Sandbox escalation denied');
  });
});

// ── applySandboxJudgment unit invariants ─────────────────────────────────────

describe('applySandboxJudgment invariants', () => {
  const mk = (verdict: SandboxJudgmentResult['verdict'], confident = true): SandboxJudgmentResult =>
    ({ verdict, riskProbability: verdict === 'looks-safe' ? 0.04 : 0.9, confident, annotation: `Jev reading: ${verdict}` });

  test('confident looks-safe + autoApprove auto-approves', () => {
    const a = applySandboxJudgment(mk('looks-safe'), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(true);
    expect(a.receipt.outcome).toBe('auto-approved');
  });
  test('looks-safe that is not confident never auto-approves', () => {
    const a = applySandboxJudgment(mk('looks-safe', false), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.receipt.outcome).toBe('annotated');
  });
  test('looks-safe + annotate-only annotates, does not auto-approve', () => {
    const a = applySandboxJudgment(mk('looks-safe'), { enabled: true, autoApprove: false }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.annotations.length).toBeGreaterThan(0);
    expect(a.receipt.outcome).toBe('annotated');
  });
  test('flags-risk + autoApprove NEVER auto-approves (annotates)', () => {
    const a = applySandboxJudgment(mk('flags-risk'), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.receipt.outcome).toBe('annotated');
  });
});

// ── the reading itself ───────────────────────────────────────────────────────

describe('runSandboxJudgment', () => {
  const input = { command: 'curl x', sandboxPlan: 'p', escalations: ESC, policyReasons: ['r'] };
  test('a low risk probability reads as looks-safe and confident', async () => {
    looksSafe();
    const r = await runSandboxJudgment(input);
    expect(r.verdict).toBe('looks-safe');
    expect(r.confident).toBe(true);
  });
  test('a high risk probability reads as flags-risk', async () => {
    flagsRisk();
    expect((await runSandboxJudgment(input)).verdict).toBe('flags-risk');
  });
  test('a middling probability reads as uncertain', async () => {
    uncertain();
    expect((await runSandboxJudgment(input)).verdict).toBe('uncertain');
  });
});
