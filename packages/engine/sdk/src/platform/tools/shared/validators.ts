import { hasCapturedToolInvocation } from './captured-input-tools.js';
/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared validator infrastructure for write and edit tools.
 * Runs typecheck / lint / test / build and returns structured results.
 */

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

/** Map validator name to shell command. */
const VALIDATOR_COMMANDS: Record<ValidatorName, string[]> = {
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: ['npx', 'eslint', '--no-error-on-unmatched-pattern'],
  test: ['bun', 'test'],
  build: ['bun', 'run', 'build'],
};

export function validatorCommand(name: ValidatorName): readonly string[] {
  const command = VALIDATOR_COMMANDS[name];
  if (!Object.hasOwn(VALIDATOR_COMMANDS, name) || !command) throw new Error('Unsupported validator');
  return command;
}

export interface ValidatorExecution { readonly assertCurrent: () => void }
export type ValidatorRunner = (name: ValidatorName, cwd: string, execution?: ValidatorExecution) => Promise<ValidatorResult>;

export interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a single validator via Bun.spawn and collect its complete result.
 */
export async function runValidator(name: ValidatorName, cwd: string, execution?: ValidatorExecution): Promise<ValidatorResult> {
  if (hasCapturedToolInvocation()) throw new Error('Captured validators require a construction-owned contained runner');
  const cmd = validatorCommand(name);

  execution?.assertCurrent();
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    validator: name,
    passed: exitCode === 0,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
  };
}

/**
 * Run all validators in sequence. Returns array of all failures (or empty array if all pass).
 */
export async function runValidators(
  validators: ValidatorName[],
  cwd: string,
  runner: ValidatorRunner = runValidator,
  assertCurrent?: () => void,
): Promise<ValidatorResult[]> {
  const failures: ValidatorResult[] = [];
  for (const name of validators) {
    assertCurrent?.();
    const result = await runner(name, cwd, assertCurrent ? { assertCurrent } : undefined);
    if (!result.passed) failures.push(result);
  }
  return failures;
}

/** Format a validator failure into a human-readable message. */
export function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):` ];
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n');
}
