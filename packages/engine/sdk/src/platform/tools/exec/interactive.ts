import { commitExecPromptAnswer, discardExecPromptAnswer } from '../../runtime/permissions/autonomous-tool-prompts.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/**
 * interactive.ts, PTY-backed prompt-answer path for the exec tool.
 *
 * PROBLEM. All exec spawn paths pipe stdout/stderr and leave stdin unwired, so
 * a child that stops to ask a question (an `ssh` host-key confirmation, a
 * `gh auth login` flow, a `sudo` password ask) hangs until the timeout and the
 * exchange is lost. Many of those prompts are written to and read from the
 * controlling terminal (`/dev/tty`), so even piping stdin would not reach them
 *, the child needs a real PTY.
 *
 * APPROACH. Commands Jev reads as likely to prompt (and any command with
 * `interactive: true`) run under a PTY allocated by the host's `script(1)`
 * binary (util-linux on Linux, the BSD variant on macOS). The PTY wrapper is
 * nested INSIDE the sandbox argv, `[...sandboxArgv, script, ...]`, so when the
 * per-command bwrap boundary is active it stays the outermost layer and holds
 * unchanged under the PTY. When output goes quiet on an unterminated last
 * line and Jev reads that line as a question waiting for an answer, the
 * pending prompt text is surfaced through the injected `requestPromptAnswer`
 * seam, wired at the composition root to the SAME approval broker as a
 * permission ask, so every surface's existing approval/attention machinery
 * renders it. The typed answer is written to the PTY and the run continues;
 * the full exchange (prompt, echoed answer, subsequent output) lands in the
 * tool result transcript.
 *
 * READINGS. Both decisions are `engine.tools.exec-prompt` readings
 * (tools/batteries/exec-prompt.ts): `will_prompt` decides whether a command
 * takes the PTY path when the caller did not say, and `awaiting_input`
 * decides whether a quiet, unterminated last line is a question. Code only
 * supplies the structure: a PTY backend exists, the process is alive, output
 * has been quiet for the window, and the last line has no newline after it.
 * Each quiet tail is read once. A no-echo password read that printed nothing
 * leaves no line to read. A prompt that is never answered (seam unwired,
 * surface ignored it, or the human walked away) ends in the normal timeout,
 * with the detected prompt text reported on the result (`pending_prompt`) so
 * the failure is diagnosable instead of a silent hang. PTY output merges
 * stderr into stdout by nature; interactive results carry the merged
 * transcript in `stdout` and note `pty: true`.
 */

import { spawnSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { sleep } from '../../utils/concurrency.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { execPrompt, pendingPromptView } from '../batteries/exec-prompt.js';
import type { ExecCommandInput, ExecCommandResult } from './schema.js';

// ── Availability (honest, probed, never faked) ───────────────────────────────

/** The honest, host-probed availability of the PTY backend. */
export interface PtyAvailability {
  readonly available: boolean;
  readonly backend: 'script' | 'none';
  /** Resolved `script` path when available. */
  readonly scriptPath?: string | undefined;
  /** util-linux (`script -qefc cmd /dev/null`) vs BSD (`script -q /dev/null sh -c cmd`) argv shape. */
  readonly flavor?: 'util-linux' | 'bsd' | undefined;
  /** Stated reason, a diagnosis when unavailable, a one-line summary when available. */
  readonly reason: string;
}

/** Raw host-probe inputs so {@link detectPtyAvailability} stays pure and unit-testable. */
export interface PtyHostProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** Resolved `script` path, or null when not on PATH. */
  readonly scriptPath: string | null;
}

/** Decide PTY availability from a host probe. Pure. */
export function detectPtyAvailability(probe: PtyHostProbe): PtyAvailability {
  if (probe.platform !== 'linux' && probe.platform !== 'darwin') {
    return {
      available: false,
      backend: 'none',
      reason: `exec PTY prompt-answer path unavailable: no script(1) argv shape is wired for platform ${probe.platform}`,
    };
  }
  if (!probe.scriptPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'exec PTY prompt-answer path unavailable: script(1) was not found on PATH',
    };
  }
  return {
    available: true,
    backend: 'script',
    scriptPath: probe.scriptPath,
    flavor: probe.platform === 'linux' ? 'util-linux' : 'bsd',
    reason: `PTY prompt-answer path available via ${probe.scriptPath} (${probe.platform === 'linux' ? 'util-linux' : 'bsd'} flavor)`,
  };
}

/** Probe the real host for a `script` binary. Impure; non-PTY platforms short-circuit. */
export function probePtyHost(): PtyHostProbe {
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { platform, scriptPath: null };
  }
  const resolved = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8', timeout: 5000 });
  const scriptPath = resolved.status === 0 ? resolved.stdout.trim() || null : null;
  return { platform, scriptPath };
}

// ── PTY argv (pure) ───────────────────────────────────────────────────────────

/**
 * Construct the PTY wrapper argv that REPLACES `['/bin/sh','-c',cmd]`. The
 * caller prepends the sandbox argv unchanged, so the boundary (when active)
 * wraps the PTY allocation itself: `[...sandboxArgv, ...buildPtyArgv(...)]`.
 */
export function buildPtyArgv(availability: PtyAvailability, command: string): string[] {
  if (!availability.available || !availability.scriptPath) {
    throw new Error(`buildPtyArgv called without an available PTY backend: ${availability.reason}`);
  }
  if (availability.flavor === 'bsd') {
    return [availability.scriptPath, '-q', '/dev/null', '/bin/sh', '-c', command];
  }
  // util-linux: -q quiet, -e return child exit code, -f flush per write, -c command
  return [availability.scriptPath, '-qefc', command, '/dev/null'];
}

// ── Prompt readings (tools/batteries/exec-prompt.ts) ─────────────────────────

const WILL_PROMPT_SITE = 'tools.exec.will-prompt';
const AWAITING_INPUT_SITE = 'tools.exec.awaiting-input';

/**
 * The unterminated last line of a transcript (no newline after it), or null
 * when the transcript ends on a newline or the last line is blank. This is
 * structure only; whether the line is a question is {@link readPendingPrompt}.
 */
export function pendingPromptLine(transcript: string): string | null {
  if (transcript.length === 0 || transcript.endsWith('\n')) return null;
  const trimmed = transcript.slice(transcript.lastIndexOf('\n') + 1).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The pending prompt of a quiet transcript, or null. Jev reads whether the
 * unterminated last line is a question waiting for an answer; any yes
 * surfaces it, since surfacing it is itself asking the owner.
 */
export async function readPendingPrompt(command: string, transcript: string, signal?: AbortSignal): Promise<string | null> {
  snapshotJudgmentInput({ command, transcript });
  const line = pendingPromptLine(transcript);
  if (line === null) return null;
  const recentOutput = transcript.slice(0, transcript.lastIndexOf('\n') + 1).slice(-RECENT_OUTPUT_CONTEXT_CHARS);
  const run = await executePolicyCheck(() => execPrompt.run(judgmentPort(AWAITING_INPUT_SITE), pendingPromptView(command, line, recentOutput), {
    site: AWAITING_INPUT_SITE,
    only: ['awaiting_input'],
  }), signal);
  signal?.throwIfAborted();
  const awaiting = run.readings.awaiting_input.verdict === 'yes';
  run.recordAction(awaiting ? 'surfaced pending prompt' : 'not a prompt');
  return awaiting ? line : null;
}

/**
 * Whether a command will most likely stop to ask for terminal input, read by
 * Jev. Only a yes that acts sends the command down the PTY path.
 */
export async function readWillPrompt(command: string, signal?: AbortSignal): Promise<boolean> {
  const run = await executePolicyCheck(() => execPrompt.run(judgmentPort(WILL_PROMPT_SITE), { command }, { site: WILL_PROMPT_SITE, only: ['will_prompt'] }), signal);
  signal?.throwIfAborted();
  const reading = run.readings.will_prompt;
  const willPrompt = reading.verdict === 'yes' && reading.outcome === 'act';
  run.recordAction(willPrompt ? 'ran under a PTY' : 'ran on pipes');
  return willPrompt;
}

// ── The interaction runtime (seam wired at the composition root) ─────────────

/** A pending prompt surfaced through the approval/attention machinery. */
export interface ExecPromptAsk {
  readonly command: string;
  /** The detected prompt line (the unterminated output tail). */
  readonly prompt: string;
  /** Bounded recent transcript for context (last ~2000 chars). */
  readonly recentOutput: string;
  readonly workingDirectory?: string | undefined;
}

/** The surface's answer. `answered: false` means the ask was declined. */
export interface ExecPromptExecution {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}

export interface ExecPromptAnswer {
  readonly answered: boolean;
  /** The text to feed the waiting child (a trailing newline is appended). */
  readonly text?: string | undefined;
}

/**
 * The resolved interactive context the exec runtime threads per call. Null on
 * a createExecTool with no interactive wiring, then every command runs the
 * unchanged pipe-based path.
 */
export interface ExecInteractionRuntime {
  readonly availability: PtyAvailability;
  /**
   * Broker a pending-prompt answer through the approval broker. Wired at the
   * composition root (see runtime/permissions/exec-prompt-wiring.ts). When
   * absent, prompts are still detected and reported on the result, but cannot
   * be answered.
   */
  readonly requestPromptAnswer?: ((ask: ExecPromptAsk, execution?: ExecPromptExecution) => Promise<ExecPromptAnswer>) | undefined;
  /** Quiet window before an unterminated last line is read as a possible prompt. Default 1200ms. */
  readonly quietWindowMs?: number | undefined;
}

const DEFAULT_QUIET_WINDOW_MS = 1200;
const QUIET_POLL_INTERVAL_MS = 150;
const RECENT_OUTPUT_CONTEXT_CHARS = 2000;

/**
 * Whether this command should take the PTY path: explicit `interactive: true`,
 * or, when the caller did not say, a `will_prompt` reading that acts; in both
 * cases only when the host actually has a PTY backend (never faked;
 * unavailable means the unchanged pipe path, and nothing is read).
 */
export async function shouldRunInteractive(
  interaction: ExecInteractionRuntime | null,
  cmdInput: ExecCommandInput,
  cmdStr: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!interaction?.availability.available) return false;
  if (cmdInput.background || cmdInput.until) return false;
  if (cmdInput.interactive === true) return true;
  if (cmdInput.interactive === false) return false;
  return readWillPrompt(cmdStr, signal);
}

// ── The interactive runner ────────────────────────────────────────────────────

interface InteractiveRunInput {
  readonly beforeSpawn?: (() => void) | undefined;
  /** Trusted boundary resources and delivery checks; never model arguments. */
  readonly extraStdio?: readonly number[] | undefined;
  readonly beforeOutput?: (() => Promise<void>) | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly cmdStr: string;
  readonly cwd: string | undefined;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly startTime: number;
  /** Sandbox argv prefix, prepended UNCHANGED so the boundary wraps the PTY. */
  readonly sandboxArgv: readonly string[];
  readonly interaction: ExecInteractionRuntime;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run a command under a PTY with the prompt-answer loop. The transcript
 * (stdout+stderr merged by the PTY) accumulates in `stdout`; each detected
 * prompt is brokered through `requestPromptAnswer` and the answer is written
 * back to the child's terminal. See the module doc for detection limits.
 */
export async function runInteractiveCommand(input: InteractiveRunInput): Promise<ExecCommandResult> {
  const { cmdStr, cwd, env, timeoutMs, startTime, interaction, signal } = input;
  const ptyArgv = buildPtyArgv(interaction.availability, cmdStr);
  const quietWindowMs = interaction.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
  const lifetime = new AbortController();
  const policySignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;

  signal?.throwIfAborted();
  input.beforeSpawn?.();
  const proc = Bun.spawn([...input.sandboxArgv, ...ptyArgv], {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    stdio: ['pipe', 'pipe', 'pipe', ...(input.extraStdio ?? [])],
  } as Parameters<typeof Bun.spawn>[1]);

  let transcript = '';
  let lastDataAt = Date.now();
  let exited = false;
  let timedOut = false;
  let cancelled = false;
  let promptsAnswered = 0;
  let promptDeclined = false;
  let pendingPrompt: string | undefined;
  /** Transcript length at the last brokered ask, re-ask only on NEW output. */
  let askedAtLength = -1;
  let askInFlight = false;

  const kill = async (): Promise<void> => {
    lifetime.abort();
    try {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] kill failed (process may have exited)', { error: String(err) });
    }
  };

  const killTimer = setTimeout(() => {
    timedOut = true;
    void kill();
  }, timeoutMs);
  killTimer.unref?.();

  const onAbort = (): void => {
    if (timedOut || cancelled) return;
    cancelled = true;
    void kill();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const readStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // PTYs emit CRLF; normalize so transcripts and prompt tails are stable.
        transcript += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (input.maxOutputChars !== undefined && transcript.length > input.maxOutputChars) {
          transcript = transcript.slice(0, input.maxOutputChars);
          judgmentFailure = new Error('Interactive output exceeded its boundary limit');
          await kill();
          return;
        }
        lastDataAt = Date.now();
      }
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] stream read ended with error', { error: summarizeError(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const writeAnswer = (text: string): void => {
    try {
      const stdin = proc.stdin as { write: (chunk: string) => unknown; flush?: () => unknown };
      stdin.write(`${text}\n`);
      stdin.flush?.();
    } catch (err: unknown) {
      logger.warn('[ExecInteractive] failed to write prompt answer to PTY', { error: summarizeError(err) });
    }
  };

  const brokerPrompt = async (prompt: string): Promise<void> => {
    askInFlight = true;
    const expectedTranscript = transcript;
    const assertCurrent = () => {
      policySignal.throwIfAborted();
      if (exited || timedOut || cancelled || transcript !== expectedTranscript || pendingPromptLine(transcript) !== prompt) throw new Error('Terminal prompt changed before response');
    };
    let answer: ExecPromptAnswer | undefined;
    try {
      await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      answer = await executePolicyCheck(() => interaction.requestPromptAnswer!({
        command: cmdStr,
        prompt,
        recentOutput: transcript.slice(-RECENT_OUTPUT_CONTEXT_CHARS),
        ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
      }, { signal: policySignal, assertCurrent }), policySignal);
      await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      if (exited || timedOut || cancelled) return;
      if (answer.answered && typeof answer.text === 'string') {
        commitExecPromptAnswer(answer, assertCurrent);
        pendingPrompt = undefined;
        promptsAnswered += 1;
        writeAnswer(answer.text);
      } else {
        // Declined: the honest move is to stop the run now, not burn the
        // remaining timeout on a child that will never get its answer.
        promptDeclined = true;
        void kill();
      }
    } catch (err: unknown) {
      if (policySignal.aborted) return;
      logger.warn('[ExecInteractive] prompt-answer broker failed; prompt left pending', { error: summarizeError(err) });
    } finally {
      if (answer) discardExecPromptAnswer(answer);
      askInFlight = false;
    }
  };

  // The quiet-window watcher: an unterminated last line + no new output
  // while the child is still alive is read once for whether it is a pending
  // prompt. A reading taken while new output arrived is stale and ignored.
  let readAtLength = -1;
  let judgmentFailure: unknown;
  const watcher = (async (): Promise<void> => {
    while (!exited && !timedOut && !cancelled) {
      await sleep(QUIET_POLL_INTERVAL_MS);
      if (exited || timedOut || cancelled || askInFlight || promptDeclined) continue;
      if (Date.now() - lastDataAt < quietWindowMs) continue;
      if (transcript.length === readAtLength || pendingPromptLine(transcript) === null) continue;
      const readLength = transcript.length;
      readAtLength = readLength;
      let prompt: string | null;
      try {
        await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
        prompt = await readPendingPrompt(cmdStr, transcript, policySignal);
        await executePolicyCheck(() => input.beforeOutput?.(), policySignal);
      } catch (err: unknown) {
        if (exited || timedOut || cancelled || promptDeclined) return;
        judgmentFailure = err;
        await kill();
        return;
      }
      if (!prompt || transcript.length !== readLength) continue;
      pendingPrompt = prompt;
      if (interaction.requestPromptAnswer && transcript.length !== askedAtLength) {
        askedAtLength = transcript.length;
        void brokerPrompt(prompt);
      }
    }
  })();

  const io = Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  const exitCode = await proc.exited;
  exited = true;
  lifetime.abort();
  clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  // Bounded drain, a PTY grandchild can hold the pipe open past the kill.
  await Promise.race([io.then(() => undefined, () => undefined), sleep(500)]);
  await watcher;
  if (judgmentFailure !== undefined) throw judgmentFailure;

  const duration = Date.now() - startTime;
  const base: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: timedOut || cancelled ? null : exitCode,
    stdout: transcript,
    stderr: '',
    success: !timedOut && !cancelled && !promptDeclined && exitCode === 0,
    duration_ms: duration,
    cwd,
    pty: true,
    ...(promptsAnswered > 0 ? { prompts_answered: promptsAnswered } : {}),
    ...(pendingPrompt !== undefined ? { pending_prompt: pendingPrompt } : {}),
    ...(promptDeclined ? { prompt_declined: true } : {}),
    ...(timedOut ? { timed_out: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
  return base;
}
