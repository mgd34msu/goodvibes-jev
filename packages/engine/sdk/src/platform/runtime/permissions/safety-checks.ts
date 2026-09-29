/**
 * The bypass-immune safety check for one tool call, as the public
 * `security.runSafetyChecks` API runs it.
 *
 * This module used to hold four lists the policy engine ran before every
 * rule: destructive command prefixes, dangerous shell patterns (curl piped to
 * a shell, writes to /etc/passwd, history clearing...), path-traversal
 * indicators and destructive SQL shapes. Each was read for what it decides:
 *
 * - Destructive prefixes and dangerous patterns decided "would this command
 *   destroy data or weaken the machine", a judgment made by spelling. It is now
 *   Jev's: the gate's boundary reading (`catastrophic`, refused outright) and
 *   stakes reading (`irreversible`, `weakensSecurity`, `obfuscated`, which make
 *   a call critical so every preset asks the owner). Here the catastrophic
 *   question is asked for each shell command the call carries.
 * - Path traversal (`/../../`) decided "is reaching outside the project an
 *   attack"; whether a call reaching beyond the project matters is the stakes
 *   reading's `beyondProject`, so the indicator list is gone. A NUL byte in a
 *   path stays code: the operating system truncates a path at NUL, so the path
 *   the call names is not the path that would be opened. That is how paths
 *   are passed, not a reading of intent.
 * - Destructive SQL fired on the tool named `query`, which in this engine
 *   records open questions and takes no SQL, and on hypothetical `db`/`sql`
 *   tools no composition registers. It decided nothing real and is gone; a
 *   shell command running SQL is read by the gate like any other command.
 *
 * The gate runs its readings before the policy evaluator, so the evaluator no
 * longer carries a safety layer of its own.
 */
import { readCatastrophic, shellCommandsIn } from '../../gate/reading.js';
import type { DecisionReason, EvaluationStep } from './types.js';

export interface SafetyCheckResult {
  /** Whether the call is blocked. */
  blocked: boolean;
  /** Reason code if blocked (always a SAFETY_* code). */
  reason?: DecisionReason | undefined;
  /** Human-readable explanation for the evaluation trace. */
  detail?: string | undefined;
  /** Steps added to the trace during evaluation (one per check run). */
  steps: EvaluationStep[];
}

/** Tool names that accept shell commands. */
const EXEC_CLASS_TOOLS: ReadonlySet<string> = new Set(['exec', 'bash', 'sh', 'run']);

/** The path-like string arguments of a call. */
function pathArgs(args: Record<string, unknown>): string[] {
  return ['path', 'file', 'file_path', 'target', 'destination', 'source']
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string');
}

/**
 * Runs the safety check for one call: a NUL byte in any path argument, then
 * the catastrophic reading of every shell command it carries. A command whose
 * reading is uncertain is blocked here, because nothing in this check can ask
 * the owner (inside the gate the same reading sends the call to the owner).
 */
export async function runSafetyChecks(toolName: string, args: Record<string, unknown>): Promise<SafetyCheckResult> {
  const steps: EvaluationStep[] = [];
  const nul = pathArgs(args).find((path) => path.includes('\0'));
  steps.push({ layer: 'safety', check: 'path-nul-byte', matched: nul !== undefined, ...(nul !== undefined ? { detail: 'a path argument contains a NUL byte' } : {}) });
  if (nul !== undefined) {
    return { blocked: true, reason: 'SAFETY_DENY_PATH_ESCAPE', detail: 'a path argument contains a NUL byte, so the path named is not the path that would be opened', steps };
  }
  if (!EXEC_CLASS_TOOLS.has(toolName)) return { blocked: false, steps };
  for (const command of shellCommandsIn(args)) {
    const { verdict } = await readCatastrophic(command, 'engine.gate.safety-check');
    const blocked = verdict !== 'no';
    steps.push({ layer: 'safety', check: 'catastrophic', matched: blocked, detail: `Jev reading: ${verdict}` });
    if (blocked) {
      return {
        blocked: true,
        reason: 'SAFETY_DENY_DESTRUCTIVE_PREFIX',
        detail: verdict === 'yes' ? 'read as destroying the machine or the user\'s data wholesale' : 'could not be read as safe',
        steps,
      };
    }
  }
  return { blocked: false, steps };
}
