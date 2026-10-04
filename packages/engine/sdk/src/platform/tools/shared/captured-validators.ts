/** Reuse the existing validator commands inside the captured executor. Neither
 * model arguments nor an ordinary validator runner can choose host execution. */
import { runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { capturedToolPublicationContext } from './captured-input-tools.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { brokerSandboxEscalation, resolveRuntimeSandboxPlan, type ExecSandboxRuntime } from '../exec/sandbox.js';
import { resolveCredentialEnvScrub, scrubCredentialEnv, type CredentialEnvScrubConfig } from '../exec/credential-env.js';
import { validatorCommand, type ValidatorRunner } from './validators.js';

export function createCapturedValidatorRunner(binding: CapturedExecAuthority, options: {
  readonly sandbox?: ExecSandboxRuntime | null | undefined;
  readonly credentialEnvScrub?: CredentialEnvScrubConfig | undefined;
} = {}): ValidatorRunner {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  const sandbox = options.sandbox ?? null;
  const scrub = resolveCredentialEnvScrub(options.credentialEnvScrub);
  return async (name, cwd) => {
    const context = capturedToolPublicationContext();
    const command = validatorCommand(name).map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
    // The ordinary shared validator has a fixed command table, not exec's
    // model-command admission path. Preserve that table while honoring this
    // member's existing exec network policy and credential environment hygiene.
    const plan = await executePolicyCheck(() => resolveRuntimeSandboxPlan(sandbox, command, binding.root, cwd), context.signal);
    const denied = await executePolicyCheck(() => brokerSandboxEscalation(sandbox, plan, command, binding.root), context.signal);
    if (denied) return { validator: name, passed: false, stdout: '', stderr: `Sandbox escalation denied: ${denied.deniedEscalations.join('; ')}`, exitCode: -1 };
    const ambient = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const environment = await executePolicyCheck(() => scrubCredentialEnv(ambient, scrub), context.signal);
    const network = !plan || plan.network === 'enabled' ? 'enabled' : 'disabled';
    const result = await runCapturedCommand(binding, command, {}, cwd, 30_000, context.signal, network, environment.env, { publicationLease: context.lease });
    return {
      validator: name,
      passed: result.success,
      exitCode: result.exit_code ?? -1,
      stdout: result.stdout,
      stderr: result.timed_out ? `Validator '${name}' timed out after 30000ms` : (result.stderr ?? ''),
    };
  };
}
