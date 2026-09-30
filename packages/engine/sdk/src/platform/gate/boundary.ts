/**
 * The gate's boundary: the checks every call passes before explicit owner
 * rules or a preset are consulted. No preset, remembered approval or phrase in
 * the conversation relaxes it. Each check was read for what it actually
 * decides (owner ruling 2026-09-27), and its disposition follows from that:
 *
 * 0. Judgment input (code, judgment-input.ts). Known protected literals are
 *    refused locally before any judgment request, including read-only calls.
 *    Hosted judgment is itself an outward transmission.
 * 1. Catastrophic commands (Jev). Whether a shell command would destroy the
 *    machine or the user's data wholesale is a judgment about what the command
 *    does; the old frozen list only knew the spellings someone wrote down.
 *    `engine.gate.boundary` `catastrophic`: a yes refuses; an uncertain
 *    reading lets the call through to the presets at critical stakes, so every
 *    preset asks the owner.
 * 2. Surface authority (code, table from gate/surface-authority.ts). What it
 *    decides is who can write to the surface the turn's instruction came from,
 *    and that is a fact about the deployment (who holds the Telegram bot, who
 *    can mail the address), not something any text in the call shows; the
 *    owner declared it per surface, and an undeclared surface is input-only.
 *    Whether the call is consequential (changes state or reaches outside the
 *    machine) is Jev's reading (`mutates`, `outward`), not the tool's category.
 * 3. Card details (Jev). Whether an outward call carries a person's payment
 *    card details is a reading (`engine.gate.boundary` `cardDetails`); a
 *    checksum cannot tell a card from an order number and misses a card written
 *    in words or split across fields. A yes refuses; an uncertain reading is
 *    refused unless the owner, shown the call, approves it.
 * 4. Outward-effect taint (Jev, over a recorded fact). Whether the turn read
 *    untrusted text is a record the untrusted-content ledger holds (code: it is
 *    what happened, not an interpretation). Whether what the call sends derives
 *    from that text is `engine.security.content-derivation`, read for each
 *    string field of the call against each recent source (security/content-taint.ts
 *    findContentTaint, the same reading the outward send paths use). When the
 *    ledger kept no text there is nothing to read, and the owner is asked.
 * 5. Trust-gated approval (code). A refusal from 3 (uncertain) or 4 is
 *    cleared only by an owner approval minted from the prompt the owner
 *    answered for this call: the check is that the approval names this action,
 *    that its fingerprint equals the fingerprint of the exact content being
 *    sent, and that its five minutes have not passed (security/owner-approval.ts).
 *    Hash equality and a clock comparison decide nothing; the owner's answer is
 *    the decision.
 *
 * Which tool calls are outward is Jev's `outward` reading alone. The earlier
 * judgment-input check protects the judgment transmission independently.
 */
import { judgmentInputProblem, JudgmentInputError } from './judgment-input.js';
import { checkOwnerApproval, type OwnerApproval } from '../security/owner-approval.js';
import { getProcessUntrustedContentLedger, type UntrustedContentLedger } from '../security/untrusted-content.js';
import { findContentTaint } from '../security/content-taint.js';
import type { GateReading } from './reading.js';
import { effectPermittedForProvenance, type AgentEffect } from './surface-authority.js';

/** The boundary's checks, in the order they run. */
export type BoundaryCheckName = 'judgment-input' | 'catastrophic' | 'surface-authority' | 'card-details' | 'outward-effect';

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
      /** Set when an owner approval over this exact content clears the refusal. */
      readonly approvable?: { readonly action: string; readonly content: Readonly<Record<string, string>> } | undefined;
    };

/** Every string value in the arguments, keyed by its path: the content an approval is bound to. */
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

export interface BoundaryInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Jev's reading of the call; null for a known read-only tool the gate did not read. */
  readonly reading: GateReading | null;
  /** The surface the turn's instruction came from; absent means the local owner session. */
  readonly surfaceId?: string | undefined;
  /** The untrusted-content ledger; the process ledger when absent. */
  readonly ledger?: UntrustedContentLedger | undefined;
  /** An owner approval the gate minted from an answered prompt for this call. */
  readonly approval?: OwnerApproval | null | undefined;
}

/** The effect a call has, for surface authority: Jev's reading, or a read for a known read-only tool. */
function effectOf(reading: GateReading | null): AgentEffect {
  if (reading === null) return 'read';
  if (reading.outward) return 'send';
  return reading.mutates ? 'write' : 'read';
}

/** The most recent untrusted sources the call's fields are read against. */
const MAX_UNTRUSTED_SOURCES = 8;

const APPROVAL_FIX = 'The owner can approve this exact call in the prompt the gate shows; nothing typed into the conversation clears it.';

/** The outward-effect check: the ledger's record, then Jev's reading of derivation. */
async function outwardCheck(input: BoundaryInput, content: Record<string, string>): Promise<BoundaryCheck & { approvable: boolean; reason?: string }> {
  const ledger = input.ledger ?? getProcessUntrustedContentLedger();
  const origins = ledger.originsThisTurn();
  if (origins.length === 0) return { check: 'outward-effect', result: 'pass', detail: 'nothing untrusted read this turn', approvable: false };
  const action = `tool:${input.toolName}`;
  const cleared = (): boolean => checkOwnerApproval({ approval: input.approval, action, contentInQuestion: content, clearingContentTaint: true }).authorized;
  const sources = ledger.taintSourcesThisTurn();
  if (sources.length === 0) {
    if (cleared()) return { check: 'outward-effect', result: 'pass', detail: 'owner approved this exact content', approvable: false };
    return {
      check: 'outward-effect',
      result: 'refuse',
      detail: `read ${origins.join(', ')}; no text kept to compare`,
      approvable: true,
      reason: `This turn read ${origins.join(', ')}, and none of that text was kept, so whether this ${input.toolName} call repeats it cannot be read. It needs the owner.`,
    };
  }
  const recentSources = sources.slice(-MAX_UNTRUSTED_SOURCES);
  if (judgmentInputProblem(recentSources)) {
    if (cleared()) return { check: 'outward-effect', result: 'pass', detail: 'owner approved this exact content', approvable: false };
    return {
      check: 'outward-effect', result: 'refuse', detail: 'protected source withheld from judgment', approvable: true,
      reason: 'Untrusted source text contains protected material and cannot be sent for a derivation reading. The owner must approve this exact outward call.',
    };
  }
  const findings = await findContentTaint(content, recentSources);
  if (findings.length === 0) {
    return { check: 'outward-effect', result: 'pass', detail: 'does not derive from untrusted text', approvable: false };
  }
  if (cleared()) {
    return { check: 'outward-effect', result: 'pass', detail: 'owner approved this exact content', approvable: false };
  }
  const fields = [...new Set(findings.map((finding) => finding.field))].join(', ');
  const from = [...new Set(findings.map((finding) => `${finding.surface} ${finding.origin}`))].join(', ');
  return {
    check: 'outward-effect',
    result: 'refuse',
    detail: `${fields} may derive from ${from}`,
    approvable: true,
    reason: `What this ${input.toolName} call sends (${fields}) may repeat or act on text read this turn from ${from}, which anyone can write.`,
  };
}

/** The privacy check runs before a judgment, hook, analysis or approval can see arguments. */
export function judgmentInputBoundary(toolName: string, args: Record<string, unknown>, workingDirectory?: string): BoundaryVerdict {
  const problem = judgmentInputProblem({ args, workingDirectory }, toolName);
  if (!problem) return { passed: true, checks: [{ check: 'judgment-input', result: 'pass' }] };
  return {
    passed: false,
    checks: [{ check: 'judgment-input', result: 'refuse', detail: problem }],
    refusedBy: 'judgment-input',
    reason: new JudgmentInputError(problem).message,
  };
}

/**
 * Runs the boundary over one call. The first refusal stops the run; the
 * checks list records every check that ran and those it skipped.
 */
export async function runBoundary(input: BoundaryInput): Promise<BoundaryVerdict> {
  const privacy = judgmentInputBoundary(input.toolName, input.args);
  if (!privacy.passed) return privacy;
  const checks: BoundaryCheck[] = [...privacy.checks];
  const refuse = (check: BoundaryCheck, reason: string, extra: Partial<Extract<BoundaryVerdict, { passed: false }>> = {}): BoundaryVerdict => {
    checks.push(check);
    return { passed: false, checks, refusedBy: check.check, reason, ...extra };
  };
  const reading = input.reading;
  const action = `tool:${input.toolName}`;

  const catastrophic = reading?.boundary.catastrophic;
  if (catastrophic === 'yes') {
    return refuse({ check: 'catastrophic', result: 'refuse', detail: 'read as destroying the machine or the user\'s data wholesale' }, 'Refused: this command reads as destroying the machine or the user\'s data wholesale. No preset, rule or approval runs it.');
  }
  checks.push(catastrophic === undefined
    ? { check: 'catastrophic', result: 'skipped' }
    : { check: 'catastrophic', result: 'pass', ...(catastrophic === 'uncertain' ? { detail: 'uncertain: critical stakes, the owner is asked' } : {}) });

  const effect = effectOf(reading);
  if (input.surfaceId !== undefined) {
    const permitted = effectPermittedForProvenance(effect, { surfaceId: input.surfaceId });
    if (!permitted.allowed) {
      return refuse({ check: 'surface-authority', result: 'refuse', detail: input.surfaceId }, permitted.problem, { fix: permitted.fix });
    }
    checks.push({ check: 'surface-authority', result: 'pass', detail: input.surfaceId });
  } else {
    checks.push({ check: 'surface-authority', result: 'pass', detail: 'local owner session' });
  }

  if (reading === null || !reading.outward) {
    checks.push({ check: 'card-details', result: 'skipped' }, { check: 'outward-effect', result: 'skipped' });
    return { passed: true, checks };
  }

  const content = stringFieldsOf(input.args);
  const card = reading.boundary.cardDetails;
  if (card === 'yes') {
    return refuse({ check: 'card-details', result: 'refuse', detail: 'carries payment card details' }, 'Refused: this call would send payment card details. Card details are entered at a local terminal or in the web UI, never sent by a tool.');
  }
  if (card === 'uncertain' && !checkOwnerApproval({ approval: input.approval, action, contentInQuestion: content, clearingContentTaint: true }).authorized) {
    return refuse({ check: 'card-details', result: 'refuse', detail: 'may carry payment card details' }, `This ${input.toolName} call may carry payment card details.`, { fix: APPROVAL_FIX, approvable: { action, content } });
  }
  checks.push({ check: 'card-details', result: 'pass', ...(card === 'uncertain' ? { detail: 'owner approved this exact content' } : {}) });

  const outward = await outwardCheck(input, content);
  if (outward.result === 'refuse') {
    return refuse({ check: 'outward-effect', result: 'refuse', detail: outward.detail }, outward.reason ?? 'outward effect refused', {
      fix: APPROVAL_FIX,
      ...(outward.approvable ? { approvable: { action, content } } : {}),
    });
  }
  checks.push({ check: 'outward-effect', result: 'pass', detail: outward.detail });
  return { passed: true, checks };
}
