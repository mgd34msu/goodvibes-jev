/**
 * Quality gates: the configured commands (`contract.gates`) whose results are
 * contract evidence and a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6). A failing gate that
 * was not skipped means the unit cannot pass, whatever the readings say.
 *
 * Whether a gate applies (a tsconfig, an ESLint config, a package script) and
 * whether its command exited zero are file-system and process facts, so all
 * of this is code.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { CONTRACT_CONFIG_DEFAULTS, getContractGateTimeoutMs, getEnabledContractGates, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';

/** One configured gate. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
}

/** The result of running one gate. */
export interface QualityGateResult {
  gate: QualityGate['name'];
  /** A skipped gate is recorded as passed, with the skip reason as its output. */
  passed: boolean;
  output: string;
  durationMs: number;
  /** True when the gate did not apply to the tree it ran against (for example, no script of that name). */
  skipped?: boolean | undefined;
}

/** The `scripts` of `cwd`'s package.json; empty when there is none or it cannot be read. */
export async function loadPackageScripts(cwd: string): Promise<Record<string, string>> {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkgJson = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
    return pkgJson.scripts ?? {};
  } catch {
    return {};
  }
}

const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
] as const;

/** Why a gate does not apply to `cwd`, or null when it does. */
export function getSkippedGateReason(gateName: string, cwd: string, pkgScripts: Record<string, string>): string | null {
  if (gateName === 'typecheck' && !existsSync(join(cwd, 'tsconfig.json'))) return 'Skipped: no tsconfig.json found';
  if (gateName === 'lint' && !ESLINT_CONFIGS.some((file) => existsSync(join(cwd, file)))) return 'Skipped: no ESLint config found';
  if (gateName === 'test' && !pkgScripts['test']) return 'Skipped: no test script in package.json';
  if (gateName === 'build' && !pkgScripts['build']) return 'Skipped: no build script in package.json';
  return null;
}

function killGateProcess(proc: ReturnType<typeof Bun.spawn>, reason: string): void {
  try {
    // The shell owns a fresh process group. Killing only the shell leaves its
    // children running with our stdout/stderr pipes open, so the timeout would
    // still wait for them and their side effects could continue afterward.
    process.kill(-proc.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    process.stderr.write(`[contract-gates] failed to kill gate process after ${reason}: ${summarizeError(error)}\n`);
  }
}

/**
 * Runs one gate command through `/bin/sh -c`. `cwd` is the unit's worktree in
 * worktree mode, so the gate sees the unit's isolated changes; omitted, the
 * command runs in the process cwd. A command still running at `timeoutMs` is
 * killed and fails, with the timeout stated at the end of its output.
 */
export async function executeGateCommand(
  command: string,
  cwd?: string,
  timeoutMs: number = CONTRACT_CONFIG_DEFAULTS.gateTimeoutMs,
): Promise<{ passed: boolean; output: string }> {
  try {
    const proc = Bun.spawn(['/bin/sh', '-c', command], { detached: true, stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGateProcess(proc, 'timeout');
    }, timeoutMs);
    timer.unref?.();
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      // Drain both streams while the command runs, and keep the deadline until
      // they close too: a shell can exit before a child releases its pipes.
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } catch (error) {
      killGateProcess(proc, 'exit-error');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const output = [stdout, stderr, timedOut ? `Gate timed out after ${timeoutMs} ms and was stopped.` : '']
      .filter(Boolean)
      .join('\n')
      .trim();
    return { passed: exitCode === 0 && !timedOut, output };
  } catch (error) {
    return { passed: false, output: summarizeError(error) };
  }
}

export interface RunContractGatesOptions {
  readonly configManager: ContractConfigReader;
  /** The tree the gates run against: the unit's worktree, the contract worktree, or the project root. */
  readonly cwd: string;
  readonly runtimeBus: RuntimeEventBus;
  readonly sessionId: string;
  readonly contractId: string;
  /** The unit, group or contract the gates are evidence for; carried by CONTRACT_GATE_RESULT. */
  readonly targetId: string;
  readonly onResult?: ((results: readonly QualityGateResult[], result: QualityGateResult) => void) | undefined;
}

/**
 * Runs every enabled `contract.gates` entry in order against `cwd`, each under
 * `contract.gateTimeoutMs`. A gate that does not apply is recorded as a
 * skipped pass. Every result is emitted as CONTRACT_GATE_RESULT.
 */
export async function runContractGates(options: RunContractGatesOptions): Promise<QualityGateResult[]> {
  const gates = getEnabledContractGates(options.configManager);
  if (gates.length === 0) return [];
  const timeoutMs = getContractGateTimeoutMs(options.configManager);
  const pkgScripts = await loadPackageScripts(options.cwd);
  const results: QualityGateResult[] = [];

  for (const gate of gates) {
    const skipReason = getSkippedGateReason(gate.name, options.cwd, pkgScripts);
    const startedAt = Date.now();
    const run = skipReason === null ? await executeGateCommand(gate.command, options.cwd, timeoutMs) : { passed: true, output: skipReason };
    const result: QualityGateResult = {
      gate: gate.name,
      passed: run.passed,
      output: run.output,
      durationMs: skipReason === null ? Date.now() - startedAt : 0,
      skipped: skipReason !== null,
    };
    results.push(result);
    emitContractEvent(options.runtimeBus, options.sessionId, {
      type: 'CONTRACT_GATE_RESULT',
      contractId: options.contractId,
      targetId: options.targetId,
      gate: gate.name,
      passed: result.passed,
      skipped: result.skipped === true,
      durationMs: result.durationMs,
    });
    options.onResult?.(results.slice(), result);
    logger.debug('contract gates: gate result', { contractId: options.contractId, targetId: options.targetId, gate: gate.name, passed: result.passed, skipped: result.skipped });
  }
  return results;
}

/** Gates that ran and failed; a skipped gate never fails. */
export function failedGates(results: readonly QualityGateResult[] | undefined): QualityGateResult[] {
  return (results ?? []).filter((result) => !result.passed && result.skipped !== true);
}
