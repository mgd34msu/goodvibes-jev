/**
 * fatal-boot-guarded-legacy-entry.ts, the fatal tail as it shipped, on purpose.
 *
 * The control for the compiled-binary disclosure test. This is the shape
 * `src/main.ts` actually used: hand `reportFatalStartupError` a `writeStderr`
 * sink of `(chunk) => process.stderr.write(chunk)`, with the terminal output
 * guard already installed.
 *
 * Compiled and run, it produces zero bytes on stdout and zero bytes on stderr,
 * because the guard replaced `process.stderr.write` with a writer that records
 * to the activity log and returns true. The reason for the crash is real, the
 * reporter runs, the logger works, and an operator watching the terminal or a
 * service journal sees nothing at all.
 *
 * Its only job is to hold that baseline still, so the fixed entry's output is
 * measured against a real one rather than an assumption, and so anyone who
 * returns the fatal sink to `process.stderr.write` fails a test instead of
 * shipping silence.
 *
 * Everything except the sink is identical to fatal-boot-guarded-entry.ts.
 */

import { join } from 'node:path';
import { configureActivityLogger, logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { reportFatalStartupError } from '@/cli/tui-startup.ts';
import { installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell';

const WORKING_DIR = process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd();

async function main(): Promise<void> {
  configureActivityLogger(join(WORKING_DIR, '.goodvibes', 'logs'));
  installFullScreenTerminalOutputGuard({
    stdout: process.stdout,
    stderr: process.stderr,
    notify: () => undefined,
  });
  throw new Error(`Global config load failed for ${join(WORKING_DIR, 'settings.json')}: JSON Parse error: Expected '}'`);
}

main().catch((err: unknown) => {
  reportFatalStartupError(err, {
    binary: 'goodvibes-agent',
    debug: process.env['GOODVIBES_AGENT_DEBUG'] === '1',
  }, {
    logError: (message, context) => logger.error(message, context),
    // The shipped sink: a property on a mutable global that the guard above
    // has already replaced. This is the whole defect.
    writeStderr: (chunk) => process.stderr.write(chunk),
    exit: (code) => process.exit(code),
  });
});
