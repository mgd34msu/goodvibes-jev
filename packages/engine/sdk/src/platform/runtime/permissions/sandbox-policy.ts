/**
 * sandbox-policy.ts, the sandbox-aware INPUT to the exec permission decision.
 *
 * This is ordinary permission-layer policy, not a new enforcement path: given a
 * command and whether the per-command exec sandbox is active, it decides whether
 * a command that would otherwise prompt ("ask") under prompt mode can auto-allow
 * because it runs entirely inside the OS boundary with no host-access need, or
 * must still surface as an explicit escalation ask that NAMES what it wants
 * (network, host-privilege escalation). A consumer composes this with its existing decision machinery: when
 * the base policy would ask an exec, it consults this to see whether the sandbox
 * turns that ask into an allow.
 *
 * What host access a command needs (network, host privileges) is Jev's reading
 * (`engine.gate.sandbox-needs`, read by readCommandNeeds and passed in). The
 * catastrophic check is the gate's and the exec guard's, and stays in force
 * inside the sandbox: a boundary never buys a catastrophic command an allow.
 * This layer only ever RELAXES an ask to an allow for commands that need no
 * host access; it can never turn a deny into an allow.
 */

import { normalizeCommand, type CommandNeeds } from './normalization/index.js';

// Public clients must obtain the same reading that this policy consumes.
export { readCommandNeeds, type CommandNeeds } from './normalization/index.js';

export type SandboxPolicyEffect = 'allow' | 'ask';

export interface SandboxPolicyDecision {
  /** The resolved effect for this exec under the sandbox-aware policy. */
  readonly effect: SandboxPolicyEffect;
  /** Whether the command would run inside the boundary. */
  readonly sandboxed: boolean;
  /**
   * Named host-access needs when `effect` is 'ask' because of them (e.g.
   * "wants network"). Empty when the command is boundary-safe and auto-allowed,
   * or when the sandbox is inactive (base policy applies).
   */
  readonly escalations: string[];
  /** Human-readable justification for the decision. */
  readonly reason: string;
}

export interface SandboxPolicyInput {
  readonly command: string;
  /**
   * Whether the sandbox is genuinely active: the capability gate
   * is on, `sandbox.enabled` config is true, AND the host can provide a boundary.
   * When false, the base policy applies unchanged.
   */
  readonly sandboxActive: boolean;
  /** Command base names (or `*`) whose network access is re-enabled in the boundary. */
  readonly egressAllowlist: readonly string[];
  /**
   * What the existing permission layer would decide for this exec absent the
   * sandbox (prompt mode → 'ask'). Returned unchanged when the sandbox is
   * inactive, so this policy is purely additive.
   */
  readonly baseEffectWhenNotSandboxed: SandboxPolicyEffect;
  /** What host access the command needs, read by Jev (normalization/classifier.ts readCommandNeeds). */
  readonly needs: CommandNeeds;
}

/** The base command names of a shell command, for matching the owner's egress allowlist. */
function baseNames(command: string): Set<string> {
  try {
    return new Set(normalizeCommand(command).segments.map((seg) => seg.command).filter((name) => name.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * Whether the owner's egress allowlist names one of the command's base
 * commands. The list is the owner's setting; matching its names against the
 * parsed command names carries out that setting and interprets nothing.
 */
function isOnEgressAllowlist(command: string, egressAllowlist: readonly string[]): boolean {
  if (egressAllowlist.includes('*')) return true;
  const bases = baseNames(command);
  return egressAllowlist.some((name) => bases.has(name));
}

/**
 * Decide, for a single exec, whether the active sandbox turns a base "ask" into
 * an "allow", or whether the command still needs a named escalation ask.
 */
export function decideSandboxedExec(input: SandboxPolicyInput): SandboxPolicyDecision {
  if (!input.sandboxActive) {
    return {
      effect: input.baseEffectWhenNotSandboxed,
      sandboxed: false,
      escalations: [],
      reason: 'sandbox not active; base permission policy applies unchanged',
    };
  }

  const escalations: string[] = [];
  if (input.needs.needsNetwork) {
    escalations.push(
      isOnEgressAllowlist(input.command, input.egressAllowlist)
        ? 'wants network (on egress allowlist, granted inside the boundary once approved)'
        : 'wants network (not on egress allowlist, denied inside the boundary unless approved)',
    );
  }
  if (input.needs.needsPrivilege) {
    escalations.push('wants host privilege escalation');
  }

  if (escalations.length > 0) {
    return {
      effect: 'ask',
      sandboxed: true,
      escalations,
      reason: `runs inside the sandbox boundary but needs host access: ${escalations.join('; ')}`,
    };
  }

  return {
    effect: 'allow',
    sandboxed: true,
    escalations: [],
    reason: 'runs inside the sandbox boundary with no host-access need, auto-allowed',
  };
}
