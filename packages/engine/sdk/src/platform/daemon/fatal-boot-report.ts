/**
 * Report fatal boot errors directly to the service's file descriptor before exit.
 * Synchronous writes bypass replaceable stream writers; partial writes are retried.
 */

import { writeSync } from 'node:fs';
import { summarizeError } from '../utils/error-display.js';
import { flushActivityLogSync, logger } from '../utils/logger.js';
import { redactSensitiveData } from '../utils/redaction.js';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

/**
 * Write `line` to `fd`, looping until every byte is accepted (or the
 * descriptor stops making progress). A single `writeSync` call can return a
 * short count for a large payload; looping is what lets this module also
 * back callers like `--help`/`--version`/status-render output, not just a
 * short fatal line.
 */
function writeLineToFd(fd: number, line: string): void {
  try {
    const payload = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf-8');
    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      // A zero-byte write would spin forever; stop and take what got through.
      if (n <= 0) break;
      written += n;
    }
  } catch {
    // A closed or unwritable descriptor must never turn a diagnostic into a
    // second failure. There is nothing further to fall back to: this IS the
    // fallback.
  }
}

/**
 * Write one line to stderr synchronously, immune to a replaced
 * `process.stderr` and to exit-time truncation. Use this for anything that
 * gates a process exit.
 */
export function writeFatalLine(line: string): void {
  writeLineToFd(STDERR_FD, line);
}

/**
 * The stdout twin, for output that must survive an exit that follows it,
 * `--install-service` prints the unit path and the follow-up commands and then
 * exits immediately, which is the same race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}

/**
 * Report a fatal boot failure everywhere it can be found, then leave the exit
 * to the caller.
 *
 * The stream write happens FIRST and synchronously. The activity log is
 * attempted after, because it is the part that can fail, it needs a
 * configured destination, a writable directory, and a flush, and the
 * guarantee this function makes is the stream line, not the log line.
 */
export function reportFatalBootFailure(error: unknown, context = 'goodvibes daemon host'): void {
  const safeContext = context === 'goodvibes daemon host' ? context : redactSensitiveData(context);
  const summary = summarizeError(error);
  let stack: string | undefined;
  if (error instanceof Error) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
        stack = redactSensitiveData(descriptor.value);
      }
    } catch {
      // A borrowed stack must not invoke an accessor on the fatal path.
    }
  }
  writeFatalLine(`${safeContext} failed: ${summary}`);
  if (stack) writeFatalLine(stack);
  try {
    logger.error(`${safeContext} failed`, { error: summary });
    flushActivityLogSync();
  } catch {
    // The reason is already on stderr, which is the guarantee. A log that
    // cannot be written must not escalate into a different failure.
  }
}
