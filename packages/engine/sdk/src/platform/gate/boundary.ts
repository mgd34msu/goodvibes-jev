/**
 * The gate's deterministic boundary: the checks every tool call passes before
 * any reading or preset is consulted. Nothing here is judged; each check is a
 * fixed list, a declared table or a ledger comparison, and no preset, rule or
 * remembered approval can relax it.
 *
 * 1. Catastrophic commands: the frozen catastrophic list
 *    (normalization/classifier.ts catastrophicReason) and the bypass-immune
 *    safety layer (runtime/permissions/safety-checks.ts).
 * 2. Surface authority: a call that changes anything, made on behalf of an
 *    input-only surface, is refused (gate/surface-authority.ts).
 * 3. Card-shape scanner: an outward call whose arguments carry card-shaped
 *    content is refused (security/card-shapes.ts). Card details are entered
 *    at a local terminal or the web UI, never sent by a tool.
 * 4. Outward-effect check: an outward call made after untrusted content
 *    entered the turn is refused unless the content it sends does not derive
 *    from what was read (security/untrusted-content.ts evaluateOutwardEffect).
 * 5. Trust-gated approval: the one thing that clears check 4 is an owner
 *    approval minted from a prompt the owner answered, bound to the exact
 *    content, single use and short-lived (security/owner-approval.ts). The
 *    gate asks for it (permissions/manager.ts); a remembered rule, a preset
 *    or a phrase in the conversation cannot stand in for it.
 *
 * Which calls are outward: a fixed tool list plus shell commands the
 * deterministic classifier marks as network, united with the calls Jev reads
 * as outward (gate/reading.ts). Jev can only add calls to the outward checks,
 * never take one out.
 */
import { normalizeCommand } from '../runtime/permissions/normalization/index.js';
import { catastrophicReason } from '../runtime/permissions/normalization/classifier.js';
import { runSafetyChecks } from '../runtime/permissions/safety-checks.js';
import { extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { detectCardShapes, hasRefusableCardShapes, renderCardShapeRefusal } from '../security/card-shapes.js';
import {
  evaluateOutwardEffect,
  getProcessUntrustedContentLedger,
  type OutwardEffectDecision,
  type UntrustedContentLedger,
} from '../security/untrusted-content.js';
import type { OwnerApproval } from '../security/owner-approval.js';
import { effectPermittedForProvenance, type AgentEffect } from './surface-authority.js';
import type { PermissionCategory } from '../permissions/types.js';

/** The boundary's checks, in the order they run. */
export type BoundaryCheckName = 'catastrophic' | 'surface-authority' | 'card-shapes' | 'outward-effect';

export interface BoundaryCheck {
  readonly check: BoundaryCheckName;
  /** `skipped` when the check does not apply to this call. */
  readonly result: 'pass' | 'refuse' | 'skipped';
  readonly detail?: string | undefined;
}

export type BoundaryVerdict =
  | { readonly passed: true; readonly checks: readonly BoundaryCheck[] }
  | {
      readonly passed: false;
      readonly checks: readonly BoundaryCheck[];
      readonly refusedBy: BoundaryCheckName;
      readonly reason: string;
      readonly fix?: string | undefined;
      /** Set for an outward-effect refusal: an owner approval over this content clears it. */
      readonly approvable?: { readonly action: string; readonly content: Readonly<Record<string, string>> } | undefined;
    };

/** Tools that accept shell commands. */
const EXEC_TOOLS: ReadonlySet<string> = new Set(['exec', 'bash', 'sh', 'run']);

/** Tools whose every call leaves the machine: messages, remote work. */
const OUTWARD_TOOLS: ReadonlySet<string> = new Set(['channel', 'remote', 'remote_trigger']);

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The shell commands a call carries, for exec-class tools only. */
export function shellCommandsOf(toolName: string, args: Record<string, unknown>): string[] {
  return EXEC_TOOLS.has(toolName) ? extractCommandArgs(args) : [];
}

/** Whether a fetch call sends a body or uses a writing method. */
function fetchSendsData(args: Record<string, unknown>): boolean {
  const urls = Array.isArray(args['urls']) ? args['urls'] : [args];
  return urls.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const method = typeof record['method'] === 'string' ? record['method'].toUpperCase() : 'GET';
    return !READ_METHODS.has(method) || record['body'] !== undefined || record['body_base64'] !== undefined || record['body_data'] !== undefined;
  });
}

/**
 * Whether code alone knows this call is outward: a tool on the fixed outward
 * list, a fetch that sends data, or a shell command classified as network.
 */
export function isOutwardByCode(toolName: string, args: Record<string, unknown>): boolean {
  if (OUTWARD_TOOLS.has(toolName)) return true;
  if (toolName === 'fetch') return fetchSendsData(args);
  return shellCommandsOf(toolName, args).some((command) => {
    try {
      return normalizeCommand(command).classifications.includes('network');
    } catch {
      return false;
    }
  });
}

/** Every string value in the arguments, keyed by its path, for the card and taint checks. */
export function stringFieldsOf(args: Record<string, unknown>, prefix = ''): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') fields[path] = value;
    else if (Array.isArray(value)) value.forEach((item, index) => {
      if (typeof item === 'string') fields[`${path}.${index}`] = item;
      else if (item && typeof item === 'object') Object.assign(fields, stringFieldsOf(item as Record<string, unknown>, `${path}.${index}`));
    });
    else if (value && typeof value === 'object') Object.assign(fields, stringFieldsOf(value as Record<string, unknown>, path));
  }
  return fields;
}

/** The catastrophic-command check: the frozen list, then the bypass-immune safety layer. */
export function catastrophicCheck(toolName: string, args: Record<string, unknown>): BoundaryCheck {
  const commands = shellCommandsOf(toolName, args);
  for (const command of commands) {
    const segments = (() => {
      try {
        return normalizeCommand(command).segments;
      } catch {
        return [];
      }
    })();
    for (const segment of segments) {
      const reason = catastrophicReason(segment);
      if (reason !== null) return { check: 'catastrophic', result: 'refuse', detail: reason };
    }
    const safety = runSafetyChecks(toolName, { command });
    if (safety.blocked) return { check: 'catastrophic', result: 'refuse', detail: safety.reason ?? 'safety check' };
  }
  if (commands.length === 0) {
    const safety = runSafetyChecks(toolName, args);
    if (safety.blocked) return { check: 'catastrophic', result: 'refuse', detail: safety.reason ?? 'safety check' };
  }
  return { check: 'catastrophic', result: 'pass' };
}

const EFFECT_FOR_CATEGORY: Readonly<Record<PermissionCategory, AgentEffect>> = {
  read: 'read',
  write: 'write',
  execute: 'exec',
  delegate: 'exec',
};

export interface BoundaryInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly category: PermissionCategory;
  /** The surface the turn's instruction came from; absent means the local owner session. */
  readonly surfaceId?: string | undefined;
  /** Whether the call is outward: code's answer united with Jev's reading. */
  readonly outward: boolean;
  /** The untrusted-content ledger; the process ledger when absent. */
  readonly ledger?: UntrustedContentLedger | undefined;
  /** An owner approval the gate minted from an answered prompt for this call. */
  readonly approval?: OwnerApproval | null | undefined;
}

const OWNER_REMEDY = { gesture: 'answer the approval prompt the gate shows you for this call' };

function outwardCheck(input: BoundaryInput, content: Record<string, string>): { check: BoundaryCheck; decision: OutwardEffectDecision } {
  const decision = evaluateOutwardEffect({
    request: { toolName: input.toolName, action: `tool:${input.toolName}`, description: `this ${input.toolName} call` },
    ledger: input.ledger ?? getProcessUntrustedContentLedger(),
    approval: input.approval ?? null,
    content,
    ownerRemedy: OWNER_REMEDY,
  });
  return {
    check: { check: 'outward-effect', result: decision.allowed ? 'pass' : 'refuse', detail: decision.reason ?? undefined },
    decision,
  };
}

/**
 * Runs the boundary over one call. The first refusal stops the run; the
 * checks list records every check that ran and those it skipped.
 */
export function runBoundary(input: BoundaryInput): BoundaryVerdict {
  const checks: BoundaryCheck[] = [];
  const refuse = (check: BoundaryCheck, reason: string, extra: Partial<Extract<BoundaryVerdict, { passed: false }>> = {}): BoundaryVerdict => {
    checks.push(check);
    return { passed: false, checks, refusedBy: check.check, reason, ...extra };
  };

  const catastrophic = catastrophicCheck(input.toolName, input.args);
  if (catastrophic.result === 'refuse') {
    return refuse(catastrophic, `Unconditionally blocked: ${catastrophic.detail}. This block is not affected by any preset, rule or approval.`);
  }
  checks.push(catastrophic);

  if (input.surfaceId !== undefined) {
    const effect = effectPermittedForProvenance(EFFECT_FOR_CATEGORY[input.category], { surfaceId: input.surfaceId });
    if (!effect.allowed) {
      return refuse({ check: 'surface-authority', result: 'refuse', detail: input.surfaceId }, effect.problem, { fix: effect.fix });
    }
    checks.push({ check: 'surface-authority', result: 'pass', detail: input.surfaceId });
  } else {
    checks.push({ check: 'surface-authority', result: 'pass', detail: 'local owner session' });
  }

  if (!input.outward) {
    checks.push({ check: 'card-shapes', result: 'skipped' }, { check: 'outward-effect', result: 'skipped' });
    return { passed: true, checks };
  }

  const content = stringFieldsOf(input.args);
  const findings = Object.values(content).flatMap((value) => [...detectCardShapes(value)]);
  if (hasRefusableCardShapes(findings)) {
    return refuse({ check: 'card-shapes', result: 'refuse', detail: `${findings.length} card-shaped span(s)` }, renderCardShapeRefusal(findings));
  }
  checks.push({ check: 'card-shapes', result: 'pass' });

  const outward = outwardCheck(input, content);
  if (!outward.decision.allowed) {
    return refuse(outward.check, outward.decision.reason ?? 'outward effect refused', {
      fix: outward.decision.fix ?? undefined,
      approvable: { action: `tool:${input.toolName}`, content },
    });
  }
  checks.push(outward.check);
  return { passed: true, checks };
}
