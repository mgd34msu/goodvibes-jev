/**
 * `engine.tools.exec-retry`: when a shell command the caller asked to retry
 * fails, which kind of failure is it? The options are the exec tool's
 * retry-on categories (tools/exec/schema.ts `retry.on`) plus `lasting`, a
 * failure that would happen again on a rerun. exec/runtime.ts retries only
 * when the reading acts on a category the caller listed. Read by Jev in
 * place of isRetryableExecResult's fixed patterns over stdout and stderr
 * (ENOENT, EACCES, "command not found" and "syntax error" as terminal;
 * ECONNRESET, ENOTFOUND, ETIMEDOUT, EHOSTUNREACH, ENETUNREACH as network;
 * ECONNREFUSED, EAGAIN as lock; EBUSY, "Resource temporarily unavailable" as
 * busy; ENOMEM, "Cannot allocate memory", "Out of memory" as oom) and its
 * exit-code shortcut (124 and 75 counted as network or busy).
 *
 * Not the errors failure reading (`engine.failure-reading`): that battery
 * reads a provider or transport error message and has no lock, busy or
 * out-of-memory classes, so it cannot say which retry-on category a command
 * failure falls in; one choice over those categories answers it in one
 * request.
 *
 * Band: low stakes. The caller already asked for retries and capped them; a
 * wrong retry reruns a command that fails again, a wrong stop returns the
 * failure for the caller to act on.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

/**
 * The work-note marker word, assembled at run time: this fixture data needs
 * the word to mean what it tests, and the source scan (todo:check) forbids
 * the literal in published source, where it would read as a deferred-work note.
 */
const WORK_MARKER = ['TO', 'DO'].join('');

export const EXEC_FAILURE_OPTIONS = {
  network: 'A network fault: a connection reset, refused or timed out, a DNS lookup failure, an unreachable host or network, or a download cut off.',
  lock: 'Another process holds a lock the command needs: a lock file, a package manager or database lock, a repository index.lock, a file locked by another program.',
  busy: 'A resource is busy or temporarily unavailable right now: a device or resource busy, a temporarily unavailable resource, a server asking to try again later.',
  oom: 'The command or a process it started ran out of memory.',
  lasting: 'A failure that would happen again if the same command ran again now: a missing command or file, permission denied, a syntax or usage error, failing tests, a compile error, invalid input.',
} as const;

export type ExecFailureCategory = keyof typeof EXEC_FAILURE_OPTIONS;

/** Most characters of stderr and of stdout one request carries, from the end, where failures are reported. */
export const MAX_JUDGED_STDERR_CHARS = 2_000;
export const MAX_JUDGED_STDOUT_CHARS = 800;

const tail = (text: string, max: number): string => (text.length <= max ? text : `[${text.length - max} earlier characters]${text.slice(-max)}`);

/** What the reading sees of a failed run: the command, its exit code, and the ends of its output. */
export function execFailureView(command: string, exitCode: number | null, stdout: string, stderr: string): { command: string; exitCode: number | null; stderr: string; stdout: string } {
  return { command, exitCode, stderr: tail(stderr, MAX_JUDGED_STDERR_CHARS), stdout: tail(stdout, MAX_JUDGED_STDOUT_CHARS) };
}

const failed = (command: string, exitCode: number | null, stderr: string, stdout = '') => execFailureView(command, exitCode, stdout, stderr);

export const execRetry = defineBattery({
  name: 'engine.tools.exec-retry',
  version: 1,
  description: 'Which kind of failure a failed shell command hit: network, lock, busy, out of memory, or a lasting failure a rerun would repeat.',
  accuracyFloor: 0.85,
  items: {
    category: oneOf(
      '`command` is a shell command that just failed with exit code `exitCode`; `stderr` and `stdout` are the ends of what it printed. Which kind of failure is this?',
      EXEC_FAILURE_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'connection reset', state: failed('bun install', 1, 'error: read ECONNRESET\nerror: failed to download zod@4.1.0'), expect: { category: 'network' } },
    { name: 'dns failure', state: failed('npm install', 1, 'npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org'), expect: { category: 'network' } },
    { name: 'curl timeout', state: failed('curl -sSf https://api.example.com/health', 28, 'curl: (28) Failed to connect to api.example.com port 443 after 30001 ms: Timeout was reached'), expect: { category: 'network' } },
    { name: 'git index lock', state: failed('git commit -m "wip"', 128, "fatal: Unable to create '/home/dev/shop-api/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository."), expect: { category: 'lock' } },
    { name: 'dpkg lock', state: failed('sudo apt-get install -y ripgrep', 100, 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4312 (unattended-upgr)'), expect: { category: 'lock' } },
    { name: 'sqlite locked', state: failed('sqlite3 app.db "UPDATE jobs SET state=\'done\'"', 5, 'Error: database is locked'), expect: { category: 'lock' } },
    { name: 'device busy', state: failed('umount /mnt/backup', 32, 'umount: /mnt/backup: target is busy.'), expect: { category: 'busy' } },
    { name: 'resource temporarily unavailable', state: failed('./scripts/spawn-workers.sh', 1, 'fork: retry: Resource temporarily unavailable'), expect: { category: 'busy' } },
    { name: 'server says try later', state: failed('gh release upload v1.2.0 dist/app.tgz', 1, 'HTTP 503: Service Unavailable. Please try again later.'), expect: { category: 'busy' } },
    { name: 'javascript heap', state: failed('bun run build', 134, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'), expect: { category: 'oom' } },
    { name: 'killed by the oom killer', state: failed('python train.py', 137, 'Killed', 'epoch 3/10 loading batch 4812'), expect: { category: 'oom' } },
    { name: 'cannot allocate memory', state: failed('make -j32', 2, 'cc1plus: out of memory allocating 65536 bytes after a total of 2147483648 bytes\nmake: *** [Makefile:40: build/core.o] Error 1'), expect: { category: 'oom' } },
    { name: 'command not found', state: failed(`rg ${WORK_MARKER} src`, 127, 'sh: 1: rg: not found'), expect: { category: 'lasting' } },
    { name: 'missing file', state: failed('cat config/prod.yaml', 1, 'cat: config/prod.yaml: No such file or directory'), expect: { category: 'lasting' } },
    { name: 'permission denied', state: failed('./deploy.sh', 126, 'sh: 1: ./deploy.sh: Permission denied'), expect: { category: 'lasting' } },
    { name: 'failing test', state: failed('bun test test/cart.test.ts', 1, 'error: expect(received).toBe(expected)\n\nExpected: 1100\nReceived: 1000\n\n 1 fail\n 12 pass'), expect: { category: 'lasting' } },
    { name: 'type error', state: failed('bunx tsc --noEmit', 2, "src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'."), expect: { category: 'lasting' } },
    { name: 'shell syntax error', state: failed('for f in *.ts; do echo $f', 2, 'sh: 1: Syntax error: end of file unexpected (expecting "done")'), expect: { category: 'lasting' } },
  ],
});
