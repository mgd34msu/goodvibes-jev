/**
 * parser.ts, this binary's command line, read by the shared argument engine.
 *
 * The engine is `parseWithCatalog` in @goodvibes-jev/engine/terminal-shell: tokens,
 * values, arity, `--`, refusals, and no knowledge of any product's commands.
 * Everything daemon-shaped is in ./command-catalog.ts, and this file is the two
 * lines that put them together.
 *
 * THE TWO RULES THE CATALOG ASKS THE ENGINE TO ENFORCE
 *
 * 1. Serving happens on a bare invocation or on `serve`, and on nothing else.
 *    Previously an unmatched word became a positional and the process fell
 *    through to "start a daemon in the foreground", so `goodvibes-daemon
 *    doctor`, `goodvibes-daemon sessions` and `goodvibes-daemon install-servce`
 *    all silently served. `unmatchedFirstToken: 'reject'` is what ends that.
 *
 * 2. Every refusal is a refusal. An unrecognized command, a flag that belongs
 *    to another surface, a flag this command does not take, a missing value,
 *    each produces an error line, and the caller exits 2 with the help. Nothing
 *    is accepted-and-ignored.
 */
import {
  findCatalogFlagArityConflicts as findConflictsIn,
  parseWithCatalog,
} from '@goodvibes-jev/engine/terminal-shell';
import { DAEMON_CLI_CATALOG } from './command-catalog.ts';
import type { DaemonCliParseResult } from './types.ts';

/**
 * Parse a daemon command line.
 *
 * Never throws: every problem comes back as a line in `errors`, so the caller
 * decides how to report it (this binary writes them to the descriptor a service
 * journal is attached to, then exits 2).
 */
export function parseDaemonCli(
  argv: readonly string[],
  binary = 'goodvibes-daemon',
): DaemonCliParseResult {
  return parseWithCatalog(argv, DAEMON_CLI_CATALOG, binary);
}

/**
 * This catalog's own consistency, checked rather than assumed.
 *
 * The engine's search for the command word runs before the command is known
 * and therefore reads arity from one table shared across commands. That is only
 * honest while no token means "boolean" under one command and "takes a value"
 * under another. Exported bound to this catalog so a unit test asserts it on
 * the real vocabulary; a violation comes back as a list of problems, never
 * thrown, so the test can name them.
 */
export function findCatalogFlagArityConflicts(): readonly string[] {
  return findConflictsIn(DAEMON_CLI_CATALOG);
}
