/**
 * The contract runner's command line (docs/design/contract-runner.md 10.1).
 * `runContractCli(argv, io, deps)` is the whole CLI and returns the exit code,
 * so a product's own `run` command can call it; the bin
 * (bin/goodvibes-contract.ts) supplies the process's streams and the live
 * runner.
 *
 *   run "<ask>" [--isolation auto|worktree|shared] [--json]
 *   status [<id>] [--json]
 *   list [--all]
 *   cancel <id>
 *   reply <id> "<text>"
 *   resume [--json]
 *
 * Every command takes `--cwd <dir>`, the project (default: the working
 * directory). `status` and `list` read the contracts on disk and run nothing;
 * the rest open the live runner, which first claims the project's contract
 * runs for this process.
 *
 * Where output goes: stdout carries the result (the answer, the tree, the
 * table, or with `--json` the JSON lines); event lines, questions, prompts and
 * status lines go to stderr.
 *
 * Exit codes: 0 passed or done; 1 failed, cancelled, unknown, refused; 2 a
 * contract waits on its owner and there is no terminal to ask on; 64 a usage
 * error; 130 interrupted (the followed contracts are cancelled).
 *
 * Session mode (design 6.6): a contract whose ask forbids delegation has its
 * one unit done by the session's own turns. The CLI hosts that session (the
 * `sessions` driver of the opened runner) and submits a turn whenever the unit
 * waits for one and no turn of that session is in flight: the ask verbatim
 * the first time in this process, then a fixed line saying the checks asked
 * for more work. The turn loop binds itself to the unit, holds at completion
 * and takes the nudges itself.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ContractEvent } from '../../events/contract.js';
import { SurfaceHomeInUseError } from '../runtime/home-single-writer.js';
import { summarizeError } from '../utils/error-display.js';
import { describeReply, finalJsonLine, formatContractEvent, isOpenContract, newestFirst, contractRow, renderContractTable, renderContractTree } from './cli-render.js';
import { openEscalation } from './intake-route.js';
import type { ResumeReport } from './resume.js';
import type { ContractRunner } from './runner.js';
import { isTerminalContractStatus, type ContractView } from './types.js';

/** The process's side of the CLI. */
export interface ContractCliIo {
  /** Writes one line to stdout. */
  out(line: string): void;
  /** Writes one line to stderr. */
  err(line: string): void;
  /** Whether a person is at a terminal to answer questions. */
  readonly isTTY: boolean;
  /** Reads one line after showing `prompt`; null at the end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Registers an interrupt (SIGINT) handler; returns its unregister. */
  onInterrupt(handler: () => void): () => void;
}

/** The runner surface the CLI uses. */
export type ContractCliRunner = Pick<ContractRunner, 'start' | 'get' | 'list' | 'cancel' | 'reply' | 'on'>;

/** The conversation sessions the CLI hosts for session-mode contracts (design 6.6). */
export interface ContractSessionDriver {
  /** True while a turn of the session is in flight. */
  isRunning(sessionId: string): boolean;
  /** Submits one user turn to the session (created on first use); resolves when the turn ends. */
  submit(sessionId: string, text: string): Promise<void>;
  /** Interrupts every turn in flight. */
  cancelAll(): void;
}

/** The live runner, opened by the bin over the project. */
export interface OpenedContractRunner {
  readonly runner: ContractCliRunner;
  /** The composition's own startup resume of the contracts on disk; null when it failed (logged). */
  resumed(): Promise<ResumeReport | null>;
  readonly sessions: ContractSessionDriver;
  dispose(): Promise<void>;
}

export interface ContractCliDeps {
  /** The project when `--cwd` is not given. */
  readonly cwd: string;
  /** The contracts stored under the project, read from disk without running anything. */
  readContracts(projectRoot: string): ContractView[];
  /** Boots the live runner over the project. Throws SurfaceHomeInUseError when another process holds the project's contract runs. */
  openRunner(projectRoot: string): Promise<OpenedContractRunner>;
  /** The CLI's conversation session id; default `cli-<uuid>`. */
  readonly newSessionId?: (() => string) | undefined;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_AWAITING_OWNER = 2;
export const EXIT_USAGE = 64;
export const EXIT_INTERRUPTED = 130;

/** The turn a session-mode contract's session is given after its first, when the unit waits again. */
export const SESSION_CONTINUE_LINE = 'The contract\'s checks asked for more work on this request. Continue the work until every acceptance criterion is met.';
/** The reason a cancel from the command line records. */
export const CLI_CANCEL_REASON = 'Cancelled from the command line.';
export const CLI_INTERRUPT_REASON = 'Interrupted from the command line.';

export const CONTRACT_CLI_USAGE = [
  'Usage: goodvibes-contract <command> [options]',
  '',
  'Commands:',
  '  run "<ask>" [--isolation auto|worktree|shared] [--json]   start a contract and follow it',
  '  status [<id>] [--json]                                    one contract\'s tree, or a table of contracts',
  '  list [--all]                                              contracts not ended (--all: every contract)',
  '  cancel <id>                                               cancel a contract',
  '  reply <id> "<text>"                                       answer a contract\'s open question',
  '  resume [--json]                                           resume the contracts on disk and follow them',
  '',
  'Every command takes --cwd <dir>, the project (default: the working directory).',
  'Exit codes: 0 passed, 1 failed or refused, 2 waiting on the owner without a terminal, 64 usage, 130 interrupted.',
];

// ── Arguments ─────────────────────────────────────────────────────────────────

type Isolation = 'auto' | 'worktree' | 'shared';

interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly projectRoot: string;
  readonly json: boolean;
  readonly all: boolean;
  readonly isolation: Isolation | undefined;
}

class UsageError extends Error {}

const COMMAND_FLAGS: Readonly<Record<string, { readonly flags: readonly string[]; readonly positionals: readonly [number, number] }>> = {
  run: { flags: ['--cwd', '--isolation', '--json'], positionals: [1, 1] },
  status: { flags: ['--cwd', '--json'], positionals: [0, 1] },
  list: { flags: ['--cwd', '--all'], positionals: [0, 0] },
  cancel: { flags: ['--cwd'], positionals: [1, 1] },
  reply: { flags: ['--cwd'], positionals: [2, 2] },
  resume: { flags: ['--cwd', '--json'], positionals: [0, 0] },
};
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--cwd', '--isolation']);
const ISOLATIONS: readonly Isolation[] = ['auto', 'worktree', 'shared'];

function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError('No command given.');
  const spec = COMMAND_FLAGS[command];
  if (spec === undefined) throw new UsageError(`Unknown command: ${command}`);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--') {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!spec.flags.includes(name)) throw new UsageError(`${command} does not take ${name}`);
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? rest[++index] : arg.slice(equals + 1);
      if (value === undefined || value.length === 0) throw new UsageError(`${name} needs a value`);
      values.set(name, value);
    } else {
      if (equals !== -1) throw new UsageError(`${name} takes no value`);
      switches.add(name);
    }
  }
  const [min, max] = spec.positionals;
  if (positionals.length < min) throw new UsageError(`${command} is missing an argument`);
  if (positionals.length > max) throw new UsageError(`${command} takes at most ${max} argument(s)`);
  if (positionals.some((positional) => positional.trim().length === 0)) throw new UsageError(`${command} was given an empty argument`);
  const isolationValue = values.get('--isolation');
  if (isolationValue !== undefined && !(ISOLATIONS as readonly string[]).includes(isolationValue)) {
    throw new UsageError(`--isolation must be one of ${ISOLATIONS.join(', ')}`);
  }
  const cwdValue = values.get('--cwd');
  const projectRoot = resolve(cwd, cwdValue ?? '.');
  if (cwdValue !== undefined && !(existsSync(projectRoot) && statSync(projectRoot).isDirectory())) {
    throw new UsageError(`--cwd names no directory: ${projectRoot}`);
  }
  return {
    command,
    positionals,
    projectRoot,
    json: switches.has('--json'),
    all: switches.has('--all'),
    isolation: isolationValue as Isolation | undefined,
  };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function runContractCli(argv: readonly string[], io: ContractCliIo, deps: ContractCliDeps): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    for (const line of CONTRACT_CLI_USAGE) io.out(line);
    return EXIT_OK;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, deps.cwd);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    for (const line of CONTRACT_CLI_USAGE) io.err(line);
    return EXIT_USAGE;
  }
  switch (args.command) {
    case 'status':
      return statusCommand(args, io, deps);
    case 'list':
      return listCommand(args, io, deps);
    default:
      return withRunner(args, io, deps);
  }
}

function statusCommand(args: ParsedArgs, io: ContractCliIo, deps: ContractCliDeps): number {
  const contracts = deps.readContracts(args.projectRoot);
  const id = args.positionals[0];
  if (id !== undefined) {
    const contract = contracts.find((candidate) => candidate.id === id);
    if (contract === undefined) {
      io.err(`No contract ${id} in ${args.projectRoot}.`);
      return EXIT_FAILED;
    }
    if (args.json) io.out(JSON.stringify(contract));
    else for (const line of renderContractTree(contract)) io.out(line);
    return EXIT_OK;
  }
  if (args.json) {
    io.out(JSON.stringify(newestFirst(contracts).map(contractRow)));
    return EXIT_OK;
  }
  if (contracts.length === 0) io.out(`No contracts in ${args.projectRoot}.`);
  else for (const line of renderContractTable(contracts)) io.out(line);
  return EXIT_OK;
}

function listCommand(args: ParsedArgs, io: ContractCliIo, deps: ContractCliDeps): number {
  const contracts = deps.readContracts(args.projectRoot).filter((contract) => args.all || isOpenContract(contract));
  if (contracts.length === 0) {
    io.out(args.all ? `No contracts in ${args.projectRoot}.` : `No contracts running in ${args.projectRoot}; --all lists the ended ones too.`);
    return EXIT_OK;
  }
  for (const line of renderContractTable(contracts)) io.out(line);
  return EXIT_OK;
}

async function withRunner(args: ParsedArgs, io: ContractCliIo, deps: ContractCliDeps): Promise<number> {
  let opened: OpenedContractRunner;
  try {
    opened = await deps.openRunner(args.projectRoot);
  } catch (error) {
    io.err(error instanceof SurfaceHomeInUseError ? error.message : `The contract runner could not start: ${summarizeError(error)}`);
    return EXIT_FAILED;
  }
  try {
    switch (args.command) {
      case 'run':
        return await runCommand(args, io, opened, deps.newSessionId?.() ?? `cli-${randomUUID()}`);
      case 'cancel':
        return await cancelCommand(args, io, opened);
      case 'reply':
        return await replyCommand(args, io, opened);
      default:
        return await resumeCommand(args, io, opened);
    }
  } finally {
    await opened.dispose();
  }
}

// ── Commands on the live runner ───────────────────────────────────────────────

async function runCommand(args: ParsedArgs, io: ContractCliIo, opened: OpenedContractRunner, sessionId: string): Promise<number> {
  const follower = createFollower(io, opened, args.json);
  let contractId: string;
  try {
    const started = opened.runner.start({
      ask: args.positionals[0]!,
      sessionId,
      origin: 'cli',
      projectRoot: args.projectRoot,
      ...(args.isolation === undefined ? {} : { isolation: args.isolation }),
    });
    contractId = started.contract.id;
  } catch (error) {
    follower.stop();
    io.err(`The contract could not start: ${summarizeError(error)}`);
    return EXIT_FAILED;
  }
  return exitCodeOf(await follower.follow([contractId]));
}

async function cancelCommand(args: ParsedArgs, io: ContractCliIo, opened: OpenedContractRunner): Promise<number> {
  const id = args.positionals[0]!;
  // The contracts on disk are held by the runner once its startup resume has read them.
  await opened.resumed();
  if (!opened.runner.cancel(id, CLI_CANCEL_REASON)) {
    io.err(`No running contract ${id} in ${args.projectRoot} (unknown or already ended).`);
    return EXIT_FAILED;
  }
  io.out(opened.runner.get(id)?.statusLine ?? `Contract ${id} cancelled.`);
  return EXIT_OK;
}

async function replyCommand(args: ParsedArgs, io: ContractCliIo, opened: OpenedContractRunner): Promise<number> {
  const [id, text] = args.positionals as [string, string];
  await opened.resumed();
  const contract = opened.runner.get(id);
  if (contract === null) {
    io.err(`No contract ${id} in ${args.projectRoot}.`);
    return EXIT_FAILED;
  }
  const waiting = openEscalation([contract]);
  if (waiting === null) {
    io.err(`Contract ${id} has no open question.`);
    return EXIT_FAILED;
  }
  try {
    const outcome = await opened.runner.reply(id, waiting.escalation.id, text);
    io.out(describeReply(id, outcome));
    return EXIT_OK;
  } catch (error) {
    io.err(`The reply to contract ${id} was not taken: ${summarizeError(error)}`);
    return EXIT_FAILED;
  }
}

async function resumeCommand(args: ParsedArgs, io: ContractCliIo, opened: OpenedContractRunner): Promise<number> {
  const follower = createFollower(io, opened, args.json);
  const report = await opened.resumed();
  if (report === null) {
    follower.stop();
    io.err(`Resuming the contracts in ${args.projectRoot} failed; the log under .goodvibes/logs says why.`);
    return EXIT_FAILED;
  }
  for (const reaped of report.reaped) io.err(`Contract ${reaped.contractId} could not resume and was failed: ${reaped.reason}`);
  const ids = [...new Set([...report.resumed.map((entry) => entry.contractId), ...report.queued, ...report.skipped])];
  if (ids.length === 0) {
    follower.stop();
    if (report.reaped.length > 0) return EXIT_FAILED;
    io.out(`Nothing to resume in ${args.projectRoot}.`);
    return EXIT_OK;
  }
  const code = exitCodeOf(await follower.follow(ids));
  // A contract reaped at resume failed, which outranks every end but an interrupt.
  return report.reaped.length > 0 && code !== EXIT_INTERRUPTED ? EXIT_FAILED : code;
}

// ── Following contracts ───────────────────────────────────────────────────────

/** How following a contract ended. `unfinished`: its session's turn ended before the unit's work was checked. */
type FollowEnd = 'passed' | 'failed' | 'cancelled' | 'waiting' | 'interrupted' | 'unfinished';

/** Interrupted wins; then any failure (a failure is final, a wait resumes); then a wait on the owner; else passed. */
function exitCodeOf(ends: readonly FollowEnd[]): number {
  if (ends.includes('interrupted')) return EXIT_INTERRUPTED;
  if (ends.some((end) => end === 'failed' || end === 'cancelled' || end === 'unfinished')) return EXIT_FAILED;
  if (ends.includes('waiting')) return EXIT_AWAITING_OWNER;
  return EXIT_OK;
}

interface Followed {
  readonly id: string;
  end: FollowEnd | null;
  readonly asked: Set<string>;
  /** Session turns this process submitted for the contract. */
  turns: number;
  turnInFlight: boolean;
}

interface Follower {
  /** Follows the contracts until each ends, waits on its owner without a terminal, or the person interrupts. */
  follow(ids: readonly string[]): Promise<FollowEnd[]>;
  /** Stops listening without following anything. */
  stop(): void;
}

/**
 * Listens from creation, so the events a contract emits before `follow` names
 * it (start emits at once; the startup resume emits before its report) are
 * held and printed when it does.
 */
function createFollower(io: ContractCliIo, opened: OpenedContractRunner, json: boolean): Follower {
  const { runner, sessions } = opened;
  const followed = new Map<string, Followed>();
  const held: ContractEvent[] = [];
  let holding = true;
  let interrupted = false;
  let onInterrupted: () => void = () => {};
  const interruptedSignal = new Promise<null>((resolveInterrupt) => { onInterrupted = () => resolveInterrupt(null); });
  let prompts: Promise<void> = Promise.resolve();
  let finished: () => void = () => {};
  const allEnded = new Promise<void>((resolveAll) => { finished = resolveAll; });
  const eventLine = json ? io.out : io.err;
  /** Questions, prompts and reply outcomes: stderr under --json, so stdout stays JSON lines. */
  const talk = io.err;

  const unsubscribe = runner.on((event) => {
    const id = event.contractId;
    if (id === undefined) return;
    const state = followed.get(id);
    if (state === undefined) {
      if (holding) held.push(event);
      return;
    }
    handle(state, event);
  });

  function handle(state: Followed, event: ContractEvent): void {
    if (state.end !== null) return;
    eventLine(json ? JSON.stringify(event) : formatContractEvent(event));
    switch (event.type) {
      case 'CONTRACT_ESCALATED':
        ask(state, event.escalationId);
        return;
      case 'CONTRACT_PASSED':
        settle(state, 'passed');
        return;
      case 'CONTRACT_FAILED':
        settle(state, 'failed');
        return;
      case 'CONTRACT_CANCELLED':
        settle(state, interrupted ? 'interrupted' : 'cancelled');
        return;
      case 'CONTRACT_STATUS_CHANGED':
      case 'CONTRACT_UNIT_STATUS_CHANGED':
        // After the runner's own step finishes: a turn is never started from inside its emit.
        queueMicrotask(() => drive(state));
        return;
      default:
        return;
    }
  }

  function settle(state: Followed, end: FollowEnd): void {
    if (state.end !== null) return;
    state.end = end;
    const contract = runner.get(state.id);
    if (json) {
      io.out(finalJsonLine(state.id, contract, end === 'waiting' ? 'awaiting-owner' : contract?.status ?? end));
    } else if (end === 'passed') {
      io.out(contract?.answer ?? '');
      io.err(contract?.statusLine ?? `Contract ${state.id} passed.`);
    } else if (end === 'waiting') {
      io.err(`Contract ${state.id} waits for your reply; answer with: goodvibes-contract reply ${state.id} "<text>"`);
    } else if (end === 'unfinished') {
      io.err(`Contract ${state.id}: the session's turn ended before its work was checked; the contract waits for a session turn, and goodvibes-contract resume takes it up again.`);
    } else {
      io.err(contract?.statusLine ?? contract?.error ?? `Contract ${state.id} ${end}.`);
    }
    if ([...followed.values()].every((candidate) => candidate.end !== null)) finished();
  }

  /** Puts an open question to the person, one at a time; without a terminal the contract is left waiting. */
  function ask(state: Followed, escalationId: string): void {
    if (state.asked.has(escalationId)) return;
    state.asked.add(escalationId);
    if (!io.isTTY) {
      settle(state, 'waiting');
      return;
    }
    prompts = prompts.then(() => converse(state, escalationId)).catch((error: unknown) => {
      talk(`Asking about contract ${state.id} stopped: ${summarizeError(error)}`);
    });
  }

  async function converse(state: Followed, first: string): Promise<void> {
    let escalationId = first;
    for (;;) {
      if (state.end !== null || interrupted) return;
      const escalation = runner.get(state.id)?.escalations.find((candidate) => candidate.id === escalationId && candidate.resolvedAt === undefined);
      if (escalation === undefined) return;
      talk(`Contract ${state.id} asks (${escalation.id}):`);
      for (const line of escalation.question.split('\n')) talk(`  ${line}`);
      const text = await Promise.race([io.readLine('Reply> '), interruptedSignal]);
      if (interrupted || state.end !== null) return;
      if (text === null) {
        settle(state, 'waiting');
        return;
      }
      // An empty line is no reply: the question is put again.
      if (text.trim().length === 0) continue;
      try {
        const outcome = await runner.reply(state.id, escalation.id, text);
        talk(describeReply(state.id, outcome));
        if (outcome.nextEscalationId === undefined) return;
        escalationId = outcome.nextEscalationId;
        state.asked.add(escalationId);
      } catch (error) {
        talk(`The reply was not taken: ${summarizeError(error)}`);
      }
    }
  }

  /** Session mode: submits a turn when the contract's unit waits for one and its session has none in flight. */
  function drive(state: Followed): void {
    if (state.end !== null || state.turnInFlight || interrupted) return;
    const contract = runner.get(state.id);
    if (contract === null || contract.sessionMode !== true || isTerminalContractStatus(contract.status)) return;
    const unit = contract.units.find((candidate) => candidate.status === 'running' || candidate.status === 'nudged');
    if (unit === undefined || sessions.isRunning(contract.sessionId)) return;
    const checksBefore = unit.checks.length;
    const text = state.turns === 0 ? contract.ask : SESSION_CONTINUE_LINE;
    state.turns += 1;
    state.turnInFlight = true;
    sessions.submit(contract.sessionId, text).catch((error: unknown) => {
      talk(`The session turn for contract ${state.id} failed: ${summarizeError(error)}`);
    }).finally(() => {
      state.turnInFlight = false;
      if (state.end !== null || interrupted) return;
      const after = runner.get(state.id)?.units.find((candidate) => candidate.id === unit.id);
      // The turn ended with the unit still waiting and no check of its work: another turn would do the same.
      if (after !== undefined && (after.status === 'running' || after.status === 'nudged') && after.checks.length === checksBefore) {
        settle(state, 'unfinished');
        return;
      }
      for (const other of followed.values()) drive(other);
    });
  }

  /** What a contract is doing when following starts: the events that brought it there may have gone before the CLI listened. */
  function catchUp(state: Followed): void {
    const contract = runner.get(state.id);
    if (contract === null) {
      talk(`Contract ${state.id} is not held by the runner.`);
      settle(state, 'failed');
      return;
    }
    if (contract.status === 'passed') settle(state, 'passed');
    else if (contract.status === 'failed') settle(state, 'failed');
    else if (contract.status === 'cancelled') settle(state, 'cancelled');
    if (state.end !== null) return;
    const waiting = openEscalation([contract]);
    if (waiting !== null) ask(state, waiting.escalation.id);
    drive(state);
  }

  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    onInterrupted();
    sessions.cancelAll();
    for (const state of followed.values()) {
      if (state.end !== null) continue;
      runner.cancel(state.id, CLI_INTERRUPT_REASON);
      settle(state, 'interrupted');
    }
  };

  return {
    async follow(ids) {
      const unregister = io.onInterrupt(interrupt);
      try {
        for (const id of ids) followed.set(id, { id, end: null, asked: new Set(), turns: 0, turnInFlight: false });
        holding = false;
        for (const event of held.splice(0)) {
          const state = event.contractId === undefined ? undefined : followed.get(event.contractId);
          if (state !== undefined) handle(state, event);
        }
        for (const state of followed.values()) catchUp(state);
        if (![...followed.values()].every((state) => state.end !== null)) await allEnded;
        return [...followed.values()].map((state) => state.end ?? 'interrupted');
      } finally {
        unregister();
        unsubscribe();
      }
    },
    stop: unsubscribe,
  };
}
