/**
 * sandbox-judgment.ts, the Jev advisory tier for the residual sandbox
 * ask-tail (the gate's sandbox-advisory battery).
 *
 * When the per-command exec sandbox is active and a command STILL lands on
 * "ask" (a boundary that needs host access, network, host-privilege
 * escalation), Jev reads the command, its sandbox plan, workspace context and
 * the policy reasons and gives a PROPOSED verdict with its probability. Its verdict either annotates the ask shown to the
 * human, or, only when the operator has opted into auto-approve mode,
 * auto-approves the ask.
 *
 * FROZEN CATASTROPHIC BLOCK / ALLOW→DENY INVARIANT. Recorded doctrine:
 * "permission settings are the sole authority for command-class risk; the
 * exec-layer unconditional block is a frozen catastrophic-only list (rm -rf /,
 * dd to devices, mkfs, fork bomb…) that must NEVER expand without the owner's
 * explicit approval." Accordingly this tier NEVER converts an allow into a deny
 * and NEVER inspects, relaxes, or re-implements the frozen catastrophic block
 * (that block is enforced independently, at exec time, and stays in force
 * identically inside the boundary). The judgment can only RELAX a standing "ask"
 * to an allow (auto-approve, and only on a `looks-safe` verdict when the
 * operator opted in) or ANNOTATE it for the human. A `flags-risk` verdict never
 * denies on its own, it annotates the human ask, which the human still decides.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { sandboxAdvisory } from '../../gate/batteries/sandbox-advisory.js';

/** The verdict the advisory reading gives: looks safe, flags risk, or cannot tell. */
export type SandboxJudgmentVerdict = 'looks-safe' | 'flags-risk' | 'uncertain';

/** Everything the reading reasons over. */
export interface SandboxJudgmentInput {
  /** The command that landed on ask. */
  readonly command: string;
  /** One-line human summary of the sandbox boundary for this command. */
  readonly sandboxPlan: string;
  /** The named host-access escalations that kept it on ask. */
  readonly escalations: readonly string[];
  /** Optional workspace context (root, project type). */
  readonly workspaceContext?: string | undefined;
  /** The policy reasons that produced the ask. */
  readonly policyReasons: readonly string[];
}

/** The resolved reading: the verdict plus a human-facing annotation. */
export interface SandboxJudgmentResult {
  readonly verdict: SandboxJudgmentVerdict;
  /** Probability that the command shows a risk the owner should see. */
  readonly riskProbability: number;
  /** Whether the reading reached act on its side; only an act can auto-approve. */
  readonly confident: boolean;
  /** "Jev reading: looks safe / flags risk / cannot tell ...". */
  readonly annotation: string;
}

/** How the reading affected the ask. */
export type SandboxJudgmentOutcome = 'annotated' | 'auto-approved';

/** The receipt every reading leaves. */
export interface SandboxJudgmentReceipt {
  readonly command: string;
  readonly verdict: SandboxJudgmentVerdict;
  readonly riskProbability: number;
  /** What happened to the ask as a result of the reading. */
  readonly outcome: SandboxJudgmentOutcome;
}

/** Config controlling the advisory tier (the `sandbox.judgment` setting and the flag). */
export interface SandboxJudgmentConfig {
  /** Whether the tier runs at all. */
  readonly enabled: boolean;
  /**
   * When true, a confident looks-safe reading AUTO-APPROVES the ask (opt-in).
   * Default false: annotate only, and the human still decides.
   */
  readonly autoApprove: boolean;
}

const percent = (p: number): string => `${Math.round(p * 100)}%`;

/**
 * Reads the escalation through `engine.gate.sandbox-advisory`. A judgment-port
 * failure propagates: the reading is required, and outage handling is the
 * provider failover chain behind the port.
 */
export async function runSandboxJudgment(input: SandboxJudgmentInput, site = 'engine.gate.sandbox-escalation'): Promise<SandboxJudgmentResult> {
  const run = await sandboxAdvisory.run(judgmentPort(site), {
    command: input.command,
    sandboxBoundary: input.sandboxPlan,
    escalations: [...input.escalations],
    policyReasons: [...input.policyReasons],
    ...(input.workspaceContext ? { workspace: input.workspaceContext } : {}),
  }, { site });
  const reading = run.readings.flagsRisk;
  const verdict: SandboxJudgmentVerdict = reading.verdict === 'no' ? 'looks-safe' : reading.verdict === 'yes' ? 'flags-risk' : 'uncertain';
  const annotation = verdict === 'looks-safe'
    ? `Jev reading: looks safe (risk ${percent(reading.probability)})`
    : verdict === 'flags-risk'
      ? `Jev reading: flags a risk to review (risk ${percent(reading.probability)})`
      : `Jev reading: cannot tell (risk ${percent(reading.probability)}); review it yourself`;
  run.recordAction(`sandbox-advisory:${verdict}`);
  return { verdict, riskProbability: reading.probability, confident: reading.outcome === 'act', annotation };
}

/**
 * Decide how a reading affects the ask, WITHOUT ever converting an allow into
 * a deny. Auto-approve only for a confident looks-safe reading AND only when
 * the operator opted in; every other case annotates the human ask.
 */
export function applySandboxJudgment(
  result: SandboxJudgmentResult,
  config: SandboxJudgmentConfig,
  command: string,
): {
  readonly autoApprove: boolean;
  readonly annotations: readonly string[];
  readonly receipt: SandboxJudgmentReceipt;
} {
  const canAutoApprove = config.autoApprove && result.verdict === 'looks-safe' && result.confident;
  const receipt = { command, verdict: result.verdict, riskProbability: result.riskProbability };
  if (canAutoApprove) return { autoApprove: true, annotations: [], receipt: { ...receipt, outcome: 'auto-approved' } };
  return { autoApprove: false, annotations: [result.annotation], receipt: { ...receipt, outcome: 'annotated' } };
}
