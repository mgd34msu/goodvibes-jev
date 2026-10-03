/**
 * fatal-boot-guarded-entry.ts, main.ts's fatal tail, with the output guard on.
 *
 * Not a test file (the suite runner collects only *.test.ts). This exists to be
 * built with `bun build --compile` and RUN, because the defect it guards is
 * invisible to a source-level test: the same source run under `bun` prints the
 * reason loudly, so every source-level test passed while the compiled artifact
 * could die mute.
 *
 * It mirrors `src/main.ts` exactly at the two points that matter:
 *
 *   1. `installFullScreenTerminalOutputGuard` with `process.stderr` as the guarded
 *      stream, the call main.ts makes once the renderer exists (line ~681),
 *      which REPLACES `process.stderr.write` so stray output cannot corrupt a
 *      rendered screen.
 *   2. `main().catch(...)` handing the real `reportFatalStartupError` the same
 *      sinks main.ts hands it.
 *
 * Nothing about the failure path is re-implemented here. The guard is the
 * shipped guard, the reporter is the shipped reporter, and the sink is the
 * shipped default. If this entry stays silent, so does the Agent.
 *
 * The activity logger is configured before the failure ON PURPOSE, so that the
 * logger genuinely has a destination. That is what makes the legacy control's
 * silence attributable to the swallowed stream rather than to a dead logger.
 */

import { join } from 'node:path';
import { configureActivityLogger, logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { reportFatalStartupError } from '@/cli/tui-startup.ts';
import { installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell';
import { writeFatalLine } from '@/utils/fatal-boot-write.ts';

const WORKING_DIR = process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd();

async function main(): Promise<void> {
  configureActivityLogger(join(WORKING_DIR, '.goodvibes', 'logs'));
  installFullScreenTerminalOutputGuard({
    stdout: process.stdout,
    stderr: process.stderr,
    notify: () => undefined,
  });
  // A startup failure raised AFTER the guard is installed, the window main.ts
  // really has, between the guard and first render (theme probe, voice capture,
  // history rebuild, first-render followups).
  throw new Error(`Global config load failed for ${join(WORKING_DIR, 'settings.json')}: JSON Parse error: Expected '}'`);
}

main().catch((err: unknown) => {
  reportFatalStartupError(err, {
    binary: 'goodvibes-agent',
    debug: process.env['GOODVIBES_AGENT_DEBUG'] === '1',
  }, {
    logError: (message, context) => logger.error(message, context),
    writeStderr: writeFatalLine,
    exit: (code) => process.exit(code),
  });
});
