/**
 * Retry for the package-install steps of the release scripts (install smoke,
 * artifact lane). npm and bun fetches hit transient connection faults on CI
 * runners; a single blip must not fail a release, and a real failure (a bad
 * tarball, a missing entry, a parse error) must not be retried.
 *
 * Whether a failure is a transient network fault is decided in two steps:
 *
 *  1. A structured errno code settles it. npm prints the error's `code` field
 *     on a fixed `npm error code <CODE>` line (`npm ERR! code` before npm 10),
 *     and a spawn failure carries it on the error object. That is a fixed
 *     format, so it stays code: a transient errno retries, any other code does
 *     not.
 *  2. With no code (bun prints prose, and npm omits the line for some
 *     failures), the wording is read by the engine failure battery through
 *     `readFailure`, and only a `transient_network` yes strong enough to act on
 *     retries. The judgment port is built from the environment the first time
 *     a reading is needed (as packages/judgment/scripts/calibrate.ts builds
 *     one), unless one is already installed; without one the install failure
 *     is reported with the reason no reading could be made. There is no
 *     pattern-list fallback.
 */
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort, JudgmentPortMissingError, readFailure } from '@goodvibes-jev/engine/errors';

type CommandError = Error & {
  readonly code?: unknown;
  readonly stderr?: Buffer | string;
  readonly stdout?: Buffer | string;
};

/** The errno codes that name a transient connection fault. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ESOCKETTIMEDOUT',
]);

/** The longest output tail handed to a reading; install output says what failed at its end. */
const MAX_EVIDENCE_CHARS = 2_000;

function outputText(value: Buffer | string | undefined): string {
  return value === undefined ? '' : value.toString();
}

/**
 * The structured error code of a failed install: the error object's own
 * `code` (a spawn failure), else the code npm printed on its fixed
 * `npm error code <CODE>` line. Null when neither is present.
 */
export function installErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const commandError = error as CommandError;
  if (typeof commandError.code === 'string' && commandError.code.length > 0) return commandError.code;
  const output = `${outputText(commandError.stderr)}\n${outputText(commandError.stdout)}`;
  const line = /^npm (?:error|ERR!) code (\S+)\s*$/m.exec(output);
  return line?.[1] ?? null;
}

/** The failure text a reading is given: the command's message and the tail of its output. */
export function installFailureText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const commandError = error as CommandError;
  const output = [outputText(commandError.stderr), outputText(commandError.stdout)]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n');
  const tail = output.length > MAX_EVIDENCE_CHARS ? output.slice(-MAX_EVIDENCE_CHARS) : output;
  return [commandError.message, tail].filter(Boolean).join('\n');
}

/** Uses the installed judgment port, building one from the environment when none is installed. */
function ensureJudgmentPort(site: string): void {
  try {
    judgmentPort(site);
  } catch (error) {
    if (!(error instanceof JudgmentPortMissingError)) throw error;
    installJudgmentPort(createSystemOnePort(judgmentConfigFromEnv(process.env)));
  }
}

/** Whether a failed install is a transient network fault worth another attempt. */
export async function isTransientInstallFailure(error: unknown, site: string): Promise<boolean> {
  const code = installErrorCode(error);
  if (code !== null) return TRANSIENT_CODES.has(code.toUpperCase());
  try {
    ensureJudgmentPort(site);
  } catch (portError) {
    const reason = portError instanceof Error ? portError.message : String(portError);
    throw new AggregateError(
      [error, portError],
      `${site}: the install failed without an error code, and its output could not be read (${reason})`,
    );
  }
  const name = error instanceof Error ? error.name : undefined;
  const failure = await readFailure({ message: installFailureText(error), errorName: name }, site);
  return failure.transientNetwork;
}

export interface InstallRetryOptions {
  /** Log prefix, e.g. `install-smoke`. */
  readonly prefix: string;
  /** What the step is, e.g. `npm install`. */
  readonly label: string;
  /** The decision site for the decision log. */
  readonly site: string;
}

const BACKOFF_MS = [0, 2000, 5000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

/**
 * Runs an install step, retrying transient network faults up to three
 * attempts with backoff. The step should capture its output (stdio 'pipe')
 * so a failure carries the text the decision reads; the output is echoed
 * either way so the run still shows it.
 */
export async function retryTransientInstall(op: () => string | void, options: InstallRetryOptions): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        const delay = BACKOFF_MS[attempt - 1] ?? 5000;
        console.log(`[${options.prefix}] ${options.label}: attempt ${attempt}/${MAX_ATTEMPTS} after ${delay}ms backoff`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      const output = op();
      if (typeof output === 'string' && output.trim()) console.log(output.trimEnd());
      return;
    } catch (err) {
      lastErr = err;
      if (err && typeof err === 'object') {
        const stdout = outputText((err as CommandError).stdout).trimEnd();
        const stderr = outputText((err as CommandError).stderr).trimEnd();
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
      }
      if (attempt === MAX_ATTEMPTS || !(await isTransientInstallFailure(err, options.site))) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${options.prefix}] ${options.label}: transient network error, retrying (${message.slice(0, 200)})`);
    }
  }
  throw lastErr;
}
