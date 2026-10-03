/**
 * fake-daemon-cli.ts, a scripted `goodvibes-daemon` executable on PATH.
 *
 * The repair path in runtime/daemon-cli-service.ts spawns the daemon's own CLI
 * by BARE NAME, so PATH decides which one answers. That is the behaviour under
 * test, and it cannot be proven by injecting a function double: a test that
 * only ever calls an injected runner never exercises the argument vector, the
 * exit-code contract, or the JSON the real command emits.
 *
 * So this builds a real executable in a scratch directory, drives it from files
 * that the test rewrites between calls, and records every invocation. The live
 * daemon on the developer's machine is never touched, nothing here resolves,
 * reads, or runs it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Printed by the fake in answer to `__selfcheck`, and by nothing else on earth.
 *
 * `withPath` demands it before it will run a test body. The real daemon CLI
 * answering instead of this one is the failure this token exists to make
 * impossible to miss: it already happened once, silently, because the runtime
 * resolves a bare command name against a PATH snapshot rather than the live
 * PATH, and the test looked like it passed through the stand-in while actually
 * running the daemon installed on the developer's machine.
 */
const SELFCHECK_TOKEN = 'goodvibes-fake-daemon-cli-selfcheck-ok';

export interface FakeDaemonCli {
  /** Directory to put on PATH, it contains the fake `goodvibes-daemon`. */
  readonly binDir: string;
  /** Absolute path of the fake executable, for tests that skip PATH entirely. */
  readonly binaryPath: string;
  /** Point `service-status` at one of the states the real CLI publishes. */
  readonly setServiceState: (state: 'running' | 'installed-not-running' | 'not-installed' | 'refused') => void;
  /** Make the next `install-service` fail with the given text on stderr. */
  readonly failInstall: (message: string) => void;
  /** Make the next `start-service` fail with the given text on stderr. */
  readonly failStart: (message: string) => void;
  /** Every invocation so far, as the argument vector the CLI received. */
  readonly calls: () => readonly string[];
}

/** Exit codes the real `service-status` publishes; mirrored so the fake is honest. */
const EXIT_FOR_STATE: Readonly<Record<string, number>> = {
  running: 0,
  refused: 1,
  'installed-not-running': 3,
  'not-installed': 4,
};

const SCRIPT = `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
if [ "\${1:-}" = "__selfcheck" ]; then
  printf '%s\\n' "${SELFCHECK_TOKEN}"
  exit 0
fi
printf '%s\\n' "$*" >> "$here/calls.log"
case "\${1:-}" in
  service-status)
    cat "$here/status.json"
    exit "$(cat "$here/status.exit")"
    ;;
  install-service)
    if [ -f "$here/install.fail" ]; then
      cat "$here/install.fail" >&2
      exit 1
    fi
    printf 'service installed and started\\n'
    printf '%s' 0 > "$here/status.exit"
    printf 'running' > "$here/state"
    exit 0
    ;;
  start-service)
    if [ -f "$here/start.fail" ]; then
      cat "$here/start.fail" >&2
      exit 1
    fi
    printf 'service start ok\\n'
    printf '%s' 0 > "$here/status.exit"
    printf 'running' > "$here/state"
    exit 0
    ;;
esac
printf 'unknown subcommand\\n' >&2
exit 2
`;

/**
 * Create the fake CLI inside `root` (use makeProjectTempDir for that root).
 *
 * Starts in the state a wedged machine is in, a unit that exists but is not
 * running, because that is the case every caller here begins from.
 */
export function createFakeDaemonCli(root: string): FakeDaemonCli {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, 'goodvibes-daemon');
  writeFileSync(binaryPath, SCRIPT, 'utf-8');
  chmodSync(binaryPath, 0o755);

  const setServiceState = (state: 'running' | 'installed-not-running' | 'not-installed' | 'refused'): void => {
    const installed = state === 'installed-not-running' || state === 'running';
    writeFileSync(join(binDir, 'status.exit'), String(EXIT_FOR_STATE[state]), 'utf-8');
    writeFileSync(join(binDir, 'state'), state, 'utf-8');
    // The same document shape the real `service-status --json` emits: the
    // fields live under `data`, and the exit code carries the actual answer.
    writeFileSync(join(binDir, 'status.json'), `${JSON.stringify({
      ok: true,
      data: {
        platform: 'systemd',
        serviceName: 'goodvibes',
        path: `${root}/systemd/goodvibes.service`,
        installed,
        running: state === 'running',
        autostart: installed,
        suggestedCommands: ['systemctl --user status goodvibes.service'],
        legacyUnitPresent: false,
        exitCode: EXIT_FOR_STATE[state],
      },
    }, null, 2)}\n`, 'utf-8');
  };
  setServiceState('installed-not-running');

  return {
    binDir,
    binaryPath,
    setServiceState,
    failInstall: (message: string) => { writeFileSync(join(binDir, 'install.fail'), `${message}\n`, 'utf-8'); },
    failStart: (message: string) => { writeFileSync(join(binDir, 'start.fail'), `${message}\n`, 'utf-8'); },
    calls: () => {
      const log = join(binDir, 'calls.log');
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
    },
  };
}

/**
 * Put `binDir` at the front of PATH for the duration of `run`, then restore it.
 *
 * PATH is process-global, so it is restored in a finally, a test that leaves a
 * scratch directory on PATH would change how every later test resolves a
 * command.
 */
export async function withPath<T>(binDir: string, run: () => Promise<T> | T): Promise<T> {
  const original = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${original ?? ''}`;
  try {
    // Prove the stand-in is the thing that answers BEFORE running the body.
    // Prepending to PATH is not by itself a guarantee, resolution has to
    // actually consult the live PATH, and a test that quietly ran the real
    // daemon would still look green while proving nothing.
    const check = spawnSync('goodvibes-daemon', ['__selfcheck'], { encoding: 'utf-8', env: process.env });
    if (check.stdout?.trim() !== SELFCHECK_TOKEN) {
      throw new Error(
        'the scripted goodvibes-daemon stand-in is not the command being resolved; refusing to run this test '
        + `against whatever answered instead (stdout: ${JSON.stringify(check.stdout ?? '')})`,
      );
    }
    return await run();
  } finally {
    if (original === undefined) delete process.env['PATH'];
    else process.env['PATH'] = original;
  }
}

/** Remove a scratch tree; used by tests that create their own root. */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
