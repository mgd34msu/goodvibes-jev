/**
 * fatal-boot-write.ts, the two descriptor writes, with nothing else attached.
 *
 * This file imports `node:fs` and nothing more, deliberately, because
 * `bin/goodvibes-agent.ts` routes through it and that shim must keep working
 * on a real npm install. This package declares NO runtime dependencies,
 * `@goodvibes-jev/engine/sdk` is a devDependency and reaches an installed user
 * only inlined inside the bundled `dist/package/main.js`, so any module the
 * shim imports that statically reaches the SDK would fail to resolve on the
 * exact installs the shim exists to explain.
 *
 * The SDK-dependent half this file does not carry, `reportFatalBootFailure`,
 * previously mirrored locally in `utils/fatal-boot-report.ts`, is the SDK's
 * own `@goodvibes-jev/engine/sdk/platform/daemon` export, which adopted this
 * file's own byte-accepting write loop as the shared implementation. Every
 * non-`bin/` caller of `writeFatalLine`/`writeExitingStdoutLine` imports them
 * from here directly.
 */

import { writeSync } from 'node:fs';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

/**
 * Write `line` to `fd`, looping until every byte is accepted.
 *
 * The loop is a deliberate local difference from the SDK's copy, which issues
 * one `writeSync` because it only ever carries a short fatal line. This repo
 * also routes `--help`, `--version`, completion scripts and the whole `status`
 * render through these functions, and a single `writeSync` of several kilobytes
 * into a pipe can return a short count, which would truncate the output rather
 * than silence it, a quieter version of the same defect. Keep the loop when the
 * SDK export is adopted, or move it upstream.
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
 * `--help`, `--version` and `completion` all print and then exit immediately,
 * which is the same race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}
