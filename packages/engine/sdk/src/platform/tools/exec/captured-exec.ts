import { projectCapturedExecBunRuntime, type CapturedExecBunRuntimeInput } from './captured-bun-runtime-input.js';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../runtime/captured-bun-runtime.js';
import { collectCommandNodes } from '../../runtime/permissions/normalization/ast.js';
import { parseAST } from '../../runtime/permissions/normalization/parser.js';
import { MAX_INPUT_LENGTH, MAX_TOKEN_COUNT, tokenize } from '../../runtime/permissions/normalization/tokenizer.js';
import { projectCapturedExecNodeRuntime, type CapturedExecNodeRuntimeInput } from './captured-exec-runtime-input.js';
import { assertCapturedPublicationOwner, type CapturedPublicationLease } from '../shared/captured-publication.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { publishCapturedProjection } from './captured-exec-publication.js';
import { executeCapturedFileOperations } from './captured-exec-file-ops.js';
import { createSafeRegex } from '../../utils/safe-regex.js';
import { runInteractiveCommand, type ExecInteractionRuntime } from './interactive.js';
import { projectCapturedExecDependencies, type CapturedExecDependencyInput } from './captured-exec-dependencies.js';
/** Commands see a permission-filtered disposable copy, never the host workspace.
 * This is a filesystem boundary, not another command/risk/retry evaluator.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import type { ExecCommandInput, ExecCommandResult, ExecFileOp } from './schema.js';

export interface CapturedExecAuthority {
  readonly bunRuntimeInput?: CapturedExecBunRuntimeInput | undefined;
  readonly bunRuntimeAdmission?: ((signal?: AbortSignal) => Promise<CapturedExecBunRuntimeInput>) | undefined;
  readonly nodeRuntimeInput?: CapturedExecNodeRuntimeInput | undefined;
  readonly nodeRuntimeAdmission?: ((signal?: AbortSignal) => Promise<CapturedExecNodeRuntimeInput>) | undefined;
  readonly nodeRuntimeUnavailable?: string | undefined;
  readonly dependencyInputs?: readonly CapturedExecDependencyInput[] | undefined;
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
}
export type CapturedExecAvailability =
  | { readonly available: true; readonly backend: 'linux-bwrap-projection' }
  | { readonly available: false; readonly reason: 'unsupported-platform' | 'unsupported-architecture' | 'missing-bwrap' | 'unusable-boundary'; readonly message: string };
const HELD = 'Captured exec held: original-owner/view authority is unavailable, changed, cancelled or restricted. Output withheld.';
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;

/** These are not exec schema inputs; never pretend that supplied stdin ran. */
export function capturedExecUnsupportedOptions(input: Record<string, unknown>): string[] {
  return ['stdin', 'input'].filter((name) => Object.prototype.hasOwnProperty.call(input, name));
}

/** No socket creation (including io_uring), no alternate ABI. Seccomp keeps
 * network isolation enforceable when bwrap's loopback setup is unavailable.
 */
function socketFilter(network: 'enabled' | 'disabled' = 'disabled'): Buffer {
  const architecture = process.arch === 'x64' ? 0xc000003e : process.arch === 'arm64' ? 0xc00000b7 : undefined;
  if (architecture === undefined) throw new Error('unsupported captured sandbox architecture');
  const denied = network === 'enabled' ? [] : process.arch === 'x64' ? [41, 53, 425] : [198, 199, 425];
  const instructions: number[][] = [
    [0x20, 0, 0, 4], [0x15, 1, 0, architecture], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
  ];
  for (const syscall of denied) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    bytes.writeUInt16LE(code!, i * 8);
    bytes[i * 8 + 2] = yes!;
    bytes[i * 8 + 3] = no!;
    bytes.writeUInt32LE(value!, i * 8 + 4);
  });
  return bytes;
}
function runtimeArgv(nodeRuntime = false, bunRuntime = false): string[] {
  const argv = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
    '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib'];
  if (existsSync('/usr/lib64')) argv.push('--ro-bind', '/usr/lib64', '/usr/lib64', '--symlink', 'usr/lib64', '/lib64');
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/captured');
  if (!bunRuntime && resolveProcessCapturedBunRuntimeExecutable() === process.execPath && (process.versions.bun || !nodeRuntime))
    argv.push('--ro-bind', process.execPath, `/captured-runtime/bin/${process.versions.bun ? 'bun' : 'node'}`);
  return argv;
}

/** Actual supported-host proof, not a PATH/existence claim. No host fallback. */
export async function probeCapturedExecAvailability(): Promise<CapturedExecAvailability> {
  if (process.platform !== 'linux') return { available: false, reason: 'unsupported-platform', message: 'Captured exec currently requires Linux with bubblewrap; this host platform has no supported captured boundary.' };
  if (process.arch !== 'x64' && process.arch !== 'arm64') return { available: false, reason: 'unsupported-architecture', message: 'Captured exec currently supports Linux x64 and arm64 only.' };
  if (!existsSync('/usr/bin/bwrap')) return { available: false, reason: 'missing-bwrap', message: 'Captured exec requires bubblewrap at /usr/bin/bwrap.' };
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'captured-exec-probe-'));
    const path = join(dir, 'sockets.bpf');
    await writeFile(path, socketFilter());
    const fd = openSync(path, 'r');
    try {
      const result = spawnSync('/usr/bin/bwrap', [...runtimeArgv(), '--chdir', '/tmp', '--seccomp', '3', '--', '/bin/true'], {
        env: {}, stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000,
      });
      if (result.status === 0) return { available: true, backend: 'linux-bwrap-projection' };
    } finally { closeSync(fd); }
  } catch { /* A fixed public capability diagnosis never includes host output. */ }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  return { available: false, reason: 'unusable-boundary', message: 'The captured exec bubblewrap mount/PID/seccomp boundary could not be established on this host. Host execution is unavailable as a fallback.' };
}
/** Validate an admitted interpreter in an empty boundary before project input
 * can run. A compiled product must never be treated as an ordinary Bun CLI.
 */
export async function probeCapturedBunRuntime(executable: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!(await probeCapturedExecAvailability()).available) return false;
  const temporary = await mkdtemp(join(tmpdir(), 'captured-bun-probe-'));
  let fd: number | undefined;
  try {
    const filter = join(temporary, 'sockets.bpf');
    await writeFile(filter, socketFilter());
    fd = openSync(filter, 'r');
    signal?.throwIfAborted();
    const argv = [...runtimeArgv(false, true), '--ro-bind', executable, '/captured-runtime/bin/bun',
      '--chdir', '/tmp', '--seccomp', '3', '--', '/captured-runtime/bin/bun', '--no-env-file', '--config=/dev/null',
      '--print', 'typeof Bun === "object" && typeof Bun.version === "string" ? "GOODVIBES_CAPTURED_ORDINARY_BUN" : "INVALID"'];
    const child = spawn('/usr/bin/bwrap', argv, { env: {}, stdio: ['ignore', 'pipe', 'ignore', fd] });
    closeSync(fd); fd = undefined;
    let output = ''; let stopped = false;
    const stop = (): void => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 5000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      child.stdout!.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 512) stop(); });
      const code = await new Promise<number | null>((resolveExit) => {
        child.once('error', () => resolveExit(null)); child.once('close', resolveExit);
      });
      signal?.throwIfAborted();
      return !stopped && code === 0 && output === 'GOODVIBES_CAPTURED_ORDINARY_BUN\n';
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    await rm(temporary, { recursive: true, force: true });
  }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export interface CapturedExecutionLease {
  readonly pid: number;
  readonly readOutput: () => Promise<ExecCommandResult>;
}
export interface CapturedExecutionObserver {
  /** Final construction-owned command admission, after all async preparation. */
  readonly beforeSpawn?: (() => void) | undefined;
  /** Final publication restriction; retained jobs supply their independent owner constraint. */
  readonly beforePublish?: (() => void) | undefined;
  /** Construction-only repair candidate. Never publishes projection changes. */
  readonly repairCandidate?: { readonly path: string; readonly content: string; readonly receive: (content: string) => void } | undefined;
  /** Construction-only owner for nested write/edit validators, never model input. */
  readonly publicationLease?: CapturedPublicationLease | undefined;
  readonly fileOps?: ExecFileOp[] | undefined;
  readonly onFileOperations?: ((result: Awaited<ReturnType<typeof executeCapturedFileOperations>>) => void) | undefined;
  readonly interaction?: ExecInteractionRuntime | undefined;
  readonly onUntilMatched?: (() => void) | undefined;
  readonly onStarted?: ((lease: CapturedExecutionLease) => void) | undefined;
}

/** Availability only: this never grants runtime/file/process authority. Keep
 * the existing simple Bun build/test and shell-primitive substrate lightweight.
 * Indirect Node use inside those Bun workflows remains unavailable unless this
 * command also requests the Node runtime. Unknown shell shapes take the full
 * construction-owned admission, never a guessed grant or a host fallback.
 */
function needsRuntime(command: string, input: ExecCommandInput, runtime: 'node' | 'bun'): boolean {
  if (input.env?.PATH !== undefined) return true;
  if (command.length >= MAX_INPUT_LENGTH || command.includes('\n') || command.includes('\r')) return true;
  const tokens = tokenize(command.trim());
  if (tokens.length === 0 || tokens.length >= MAX_TOKEN_COUNT) return true;
  if (tokens.some((token) => token.type === 'subshell' || token.value.startsWith('<<') ||
    (token.type !== 'operator' && token.type !== 'pipe' && /[$`\\&(){}#]/.test(token.value)))) return true;
  const nodes = collectCommandNodes(parseAST(tokens));
  const consumed = new Set(nodes.flatMap((node) => node.tokens.map((token) => token.position)));
  if (nodes.length === 0 || nodes.some((node) => node.parseError) ||
    tokens.some((token) => token.type !== 'operator' && token.type !== 'pipe' && !consumed.has(token.position))) return true;
  const literal = (value: string | undefined, word: string): boolean =>
    value === word || value === `'${word}'` || value === `"${word}"`;
  const primitives = new Set([':', 'true', 'false', 'echo', 'printf', 'sleep', 'pwd', 'cd', 'test', '[']);
  return nodes.some((node) => {
    if (node.tokens[0]?.type !== 'command' || !literal(node.tokens[0].value, node.command)) return true;
    if (primitives.has(node.command)) return false;
    if (runtime === 'bun') return true;
    const argument = (index: number, word: string): boolean =>
      node.tokens[index]?.type === 'argument' && literal(node.tokens[index]?.value, word);
    return node.command !== 'bun' || !(argument(1, 'build') || argument(1, 'test') ||
      (argument(1, 'run') && (argument(2, 'build') || argument(2, 'test'))));
  });
}

export async function runCapturedCommand(
  binding: CapturedExecAuthority,
  command: string,
  input: ExecCommandInput,
  workingDirectory: string,
  timeoutMs: number,
  signal?: AbortSignal,
  network: 'enabled' | 'disabled' = 'disabled',
  ambientEnvironment: Readonly<Record<string, string>> = {},
  observer: CapturedExecutionObserver = {},
): Promise<ExecCommandResult> {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  input = structuredClone(input);
  observer = { ...observer, repairCandidate: observer.repairCandidate ? Object.freeze({ ...observer.repairCandidate }) : undefined, fileOps: observer.fileOps ? structuredClone(observer.fileOps) : undefined };
  const start = Date.now();
  const root = resolve(binding.root);
  const cwd = resolve(workingDirectory, input.cwd ?? '.');
  const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  const operations = new AbortController();
  const operationSignal = combined ? AbortSignal.any([combined, operations.signal]) : operations.signal;
  let temporary: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let killed = false;
  let timedOut = false;
  let invalid = false;
  let untilMatched = false;
  let validation: Promise<void> = Promise.resolve();
  let validating = false;
  let stop = (): void => {};
  let childCompletion: Promise<number | null> | undefined;
  const paths = new Set<string>();
  let checkDependencies = async (): Promise<void> => {};
  const authorize = (path: string): Promise<string> => executePolicyCheck(
    () => authorizeContractInputPath(binding.authority, path, binding.readAccessFilter, operationSignal), operationSignal);
  const check = async (): Promise<void> => executePolicyCheck(async () => {
    if (observer.repairCandidate) {
      if (!observer.publicationLease) throw new Error('repair requires its active publication owner');
      assertCapturedPublicationOwner(observer.publicationLease, binding.authority);
    }
    if (!binding.readAccessFilter) throw new Error('captured exec requires original-owner read authorization');
    await assertContractInputAuthority(binding.authority, root, combined);
    for (const path of paths) await authorize(path);
    await checkDependencies();
    if (observer.repairCandidate) assertCapturedPublicationOwner(observer.publicationLease!, binding.authority);
  }, operationSignal);
  try {
    if (!within(root, resolve(workingDirectory)) || !within(root, cwd)) throw new Error('outside captured working directory');
    if (['/usr', '/bin', '/lib', '/lib64', '/proc', '/dev'].some((path) => within(path, root) || within(root, path)))
      throw new Error('captured root overlaps runtime mounts');
    const unsupported = capturedExecUnsupportedOptions(input as unknown as Record<string, unknown>);
    if (unsupported.length > 0) return {
      cmd: command, cwd, exit_code: null, stdout: '', success: false, denied: true,
      stderr: 'Captured exec does not support stdin/input options; use a shell pipe or an authorized input file.',
      captured_exec_unsupported_options: unsupported,
    };
    if (input.background) throw new Error('captured background must be retained by its ProcessManager owner');
    await using untilPattern = input.until ? await createSafeRegex(input.until.pattern, '', { operation: 'exec until pattern', maxInputChars: 500_000, signal: operationSignal }) : undefined;
    await check();
    const availability = await probeCapturedExecAvailability();
    await check();
    if (!availability.available) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: availability.message, success: false, denied: true,
      sandboxed: false, sandbox_boundary: 'captured boundary unavailable', captured_exec_availability: availability, duration_ms: Date.now() - start };
    if (cwd !== root) await authorize(cwd);
    // Runtime selection changes availability only. Fixed validators and every
    // selected command share the existing construction-owned pinned admission.
    if (!binding.nodeRuntimeInput && binding.nodeRuntimeAdmission && needsRuntime(command, input, 'node')) {
      try {
        const nodeRuntimeInput = await executePolicyCheck(() => binding.nodeRuntimeAdmission!(operationSignal), operationSignal);
        binding = Object.freeze({ ...binding, nodeRuntimeInput });
      } catch {
        operationSignal.throwIfAborted();
        await check();
      }
    }
    if (!binding.bunRuntimeInput && binding.bunRuntimeAdmission && needsRuntime(command, input, 'bun')) {
      try {
        const bunRuntimeInput = await executePolicyCheck(() => binding.bunRuntimeAdmission!(operationSignal), operationSignal);
        binding = Object.freeze({ ...binding, bunRuntimeInput });
      } catch {
        operationSignal.throwIfAborted();
        await check();
      }
    }
    temporary = await mkdtemp(join(tmpdir(), 'goodvibes-captured-exec-'));
    const projection = join(temporary, 'view');
    await mkdir(projection);
    const originals = new Map<string, { data: Buffer; mode: number }>();
    const originalDirectories = new Map<string, number>();
    let bytes = 0;
    const populate = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        if (CONTRACT_INPUT_EXCLUSIONS.includes(entry.name as typeof CONTRACT_INPUT_EXCLUSIONS[number])) continue;
        const rel = join(dir, entry.name);
        const source = join(root, rel);
        try { await authorize(source); }
        catch { await assertContractInputAuthority(binding.authority, root, combined); continue; }
        const stat = await lstat(source);
        if (stat.isDirectory()) { originalDirectories.set(rel, stat.mode & 0o777); await mkdir(join(projection, rel), { recursive: true, mode: stat.mode & 0o777 }); await chmod(join(projection, rel), stat.mode & 0o777); await populate(rel); }
        else if (stat.isFile() && !stat.isSymbolicLink()) {
          if (stat.size > 32 * 1024 * 1024 || bytes + stat.size > MAX_BYTES) throw new Error('captured input exceeds byte limit');
          const data = await readFile(source);
          await authorize(source);
          paths.add(source);
          bytes += data.length;
          if (originals.size >= MAX_FILES || bytes > MAX_BYTES) throw new Error('captured projection exceeds resource limit');
          originals.set(rel, { data, mode: stat.mode & 0o777 });
          await writeFile(join(projection, rel), data, { mode: stat.mode & 0o777 });
          await chmod(join(projection, rel), stat.mode & 0o777);
        }
      }
    };
    await populate('');
    const candidate = observer.repairCandidate;
    let candidateRelative: string | undefined;
    if (candidate) {
      if (!observer.publicationLease) throw new Error('repair requires its active publication owner');
      assertCapturedPublicationOwner(observer.publicationLease, binding.authority);
      const target = resolve(root, candidate.path);
      candidateRelative = relative(root, target);
      await authorize(target);
      if (!candidateRelative || !originals.has(candidateRelative) || Buffer.byteLength(candidate.content) > 32 * 1024 * 1024)
        throw new Error('repair candidate requires one existing admitted file');
      paths.add(target);
      await writeFile(join(projection, candidateRelative), candidate.content, 'utf8');
      await check();
    }
    if (observer.fileOps?.some((operation) => operation.op !== 'delete' || !operation.dry_run) && !contractInputAuthorityMutable(binding.authority))
      throw new Error('immutable captured input cannot apply file operations');
    const fileOperations = await executeCapturedFileOperations(root, projection, observer.fileOps,
      authorize);
    observer.onFileOperations?.(fileOperations);
    const dependencies = await projectCapturedExecDependencies(binding, temporary, operationSignal, projection);
    const nodeRuntime = await projectCapturedExecNodeRuntime(binding, temporary, operationSignal);
    const bunRuntime = await projectCapturedExecBunRuntime(binding, temporary, operationSignal);
    checkDependencies = async () => { await dependencies.check(); await nodeRuntime.check(); await bunRuntime.check(); };
    await check();
    const filterPath = join(temporary, 'sockets.bpf');
    await writeFile(filterPath, socketFilter(network));
    const fd = openSync(filterPath, 'r');
    const argv = runtimeArgv(Boolean(binding.nodeRuntimeInput || binding.nodeRuntimeAdmission), Boolean(binding.bunRuntimeInput || binding.bunRuntimeAdmission));
    argv.push(...nodeRuntime.argv, ...bunRuntime.argv);
    argv.push(contractInputAuthorityMutable(binding.authority) ? '--bind' : '--ro-bind', projection, root,
      '--chdir', cwd, '--seccomp', '3');
    for (const mount of dependencies.mounts) argv.push('--ro-bind', mount.source, mount.target);
    const environment = { ...ambientEnvironment, PATH: '/captured-runtime/bin:/usr/bin:/bin', HOME: '/home/captured', TMPDIR: '/tmp', LANG: ambientEnvironment.LANG ?? 'C.UTF-8', ...input.env };
    const boundaryStop = new AbortController();
    const executionSignal = combined ? AbortSignal.any([combined, boundaryStop.signal]) : boundaryStop.signal;
    stop = () => { killed = true; operations.abort(); boundaryStop.abort(); };
    monitor = setInterval(() => {
      if (validating) return;
      validating = true;
      validation = check().catch(() => { invalid = true; stop(); }).finally(() => { validating = false; });
    }, 50);
    let stdout = ''; let stderr = '';
    let exitCode: number | null;
    let modeResult: ExecCommandResult | undefined;
    if (observer.interaction) {
      try {
        modeResult = await runInteractiveCommand({
          cmdStr: command, cwd: undefined, env: environment, timeoutMs, startTime: start,
          sandboxArgv: ['/usr/bin/bwrap', ...argv, '--'], interaction: observer.interaction,
          signal: executionSignal, beforeSpawn: observer.beforeSpawn, extraStdio: [fd], beforeOutput: check, maxOutputChars: MAX_OUTPUT,
        });
        stdout = modeResult.stdout; stderr = modeResult.stderr; exitCode = modeResult.exit_code;
        timedOut = modeResult.timed_out === true;
        killed = killed || timedOut || modeResult.cancelled === true;
        if (killed) operations.abort();
      } finally { closeSync(fd); clearInterval(monitor); }
    } else {
      argv.push('--', '/bin/sh', '-c', command);
      let child: ReturnType<typeof spawn>;
      try {
        executionSignal.throwIfAborted();
        if (candidate) assertCapturedPublicationOwner(observer.publicationLease!, binding.authority);
        observer.beforeSpawn?.();
        child = spawn('/usr/bin/bwrap', argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe', fd] });
      } finally { closeSync(fd); }
      childCompletion = new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject); child.once('close', resolveExit);
      });
      void childCompletion.catch(() => {});
      stop = () => { killed = true; operations.abort(); child.kill('SIGKILL'); };
      const onAbort = (): void => { invalid = true; stop(); };
      executionSignal.addEventListener('abort', onAbort, { once: true });
      if (executionSignal.aborted) onAbort();
      const timeout = (): void => { timedOut = true; stop(); };
      timer = setTimeout(timeout, input.until?.timeout_ms ?? timeoutMs);
      let untilDirty = false;
      let checkingUntil = false;
      let untilCompletion: Promise<void> = Promise.resolve();
      const capture = (data: Buffer, output: 'stdout' | 'stderr'): void => {
        if (output === 'stdout') stdout += data.toString(); else stderr += data.toString();
        if (stdout.length + stderr.length > MAX_OUTPUT) { invalid = true; stop(); return; }
        untilDirty = true;
        if (checkingUntil || !untilPattern || untilMatched) return;
        checkingUntil = true;
        untilCompletion = (async () => {
          try {
            while (untilDirty && !untilMatched) {
              untilDirty = false;
              if (await untilPattern.test(stdout + stderr)) {
                await check();
                untilMatched = true;
                clearTimeout(timer);
                if (input.until?.kill_after) child.kill('SIGKILL');
                else timer = setTimeout(timeout, timeoutMs);
                observer.onUntilMatched?.();
              }
            }
          } catch { invalid = true; stop(); }
          finally { checkingUntil = false; }
        })();
      };
      child.stdout!.on('data', (data: Buffer) => capture(data, 'stdout'));
      child.stderr!.on('data', (data: Buffer) => capture(data, 'stderr'));
      observer.onStarted?.({ pid: child.pid!, readOutput: async () => {
        await check();
        const snapshot = { cmd: command, cwd, exit_code: child.exitCode, stdout, stderr, success: true, sandboxed: true };
        await check();
        return snapshot;
      } });
      exitCode = await childCompletion;
      await untilCompletion;
      clearInterval(monitor); clearTimeout(timer); executionSignal.removeEventListener('abort', onAbort);
    }
    await validation;
    await check();
    if (invalid) throw new Error('authority changed');
    if (killed) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: '', success: false, timed_out: timedOut, duration_ms: Date.now() - start };
    const changes = new Map<string, { data: Buffer; mode: number }>();
    const present = new Set<string>();
    const directories = new Map<string, number>();
    let resultBytes = 0;
    const inspect = async (dir: string): Promise<boolean> => {
      let retained = false;
      for (const entry of await readdir(join(projection, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        const target = join(root, rel);
        if (dependencies.mounts.some((mount) => mount.target === target)) continue;
        await authorize(target);
        paths.add(target);
        const stat = await lstat(join(projection, rel));
        if (stat.isDirectory()) {
          const children = await inspect(rel);
          if (!originalDirectories.has(rel) && !children && dependencies.mounts.some((mount) => within(target, mount.target))) continue;
          directories.set(rel, stat.mode & 0o777);
          retained = true;
        }
        else if (stat.isFile() && !stat.isSymbolicLink()) {
          if (candidateRelative === rel && stat.nlink !== 1) throw new Error('repair candidate is a hardlink');
          if (stat.size > 32 * 1024 * 1024 || resultBytes + stat.size > MAX_BYTES) throw new Error('captured output exceeds byte limit');
          const data = await readFile(join(projection, rel));
          resultBytes += data.length;
          if (present.size >= MAX_FILES || resultBytes > MAX_BYTES) throw new Error('captured output exceeds resource limit');
          present.add(rel);
          retained = true;
          const previous = originals.get(rel);
          if (!previous?.data.equals(data) || previous.mode !== (stat.mode & 0o777)) changes.set(rel, { data, mode: stat.mode & 0o777 });
        } else throw new Error('captured output contains an alias or special file');
      }
      return retained;
    };
    await inspect('');
    await check();
    untilPattern?.assertCurrent();
    if (!candidate && contractInputAuthorityMutable(binding.authority))
      await publishCapturedProjection(binding, originals, originalDirectories, present, directories, changes, combined, observer.publicationLease, observer.beforePublish);
    await check();
    if (candidate && candidateRelative) {
      assertCapturedPublicationOwner(observer.publicationLease!, binding.authority);
      if (!present.has(candidateRelative)) throw new Error('repair removed its target');
      const bytes = changes.get(candidateRelative)?.data ?? originals.get(candidateRelative)!.data;
      combined?.throwIfAborted();
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('repair candidate is not valid UTF-8');
      candidate.receive(text);
    }
    const failures: string[] = [];
    if (fileOperations.fileOpError) failures.push(fileOperations.fileOpError);
    if (input.expect?.exit_code !== undefined && exitCode !== input.expect.exit_code) failures.push('exit_code expectation failed');
    if (input.expect?.stdout_contains !== undefined && !stdout.includes(input.expect.stdout_contains)) failures.push('stdout expectation failed');
    if (input.expect?.stderr_contains !== undefined && !stderr.includes(input.expect.stderr_contains)) failures.push('stderr expectation failed');
    return { ...modeResult, cmd: command, cwd, exit_code: exitCode, stdout, stderr, success: (input.until ? untilMatched : (modeResult?.success ?? exitCode === 0)) && failures.length === 0,
      duration_ms: Date.now() - start, sandboxed: true, sandbox_boundary: `captured authorized projection; isolated PID/mounts; network ${network}`, sandbox_network: network,
      captured_exec_availability: availability, ...(failures.length ? { expectation_error: failures.join('; ') } : {}) };
  } catch {
    stop();
    await childCompletion?.catch(() => {});
    if (timedOut) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: '', success: false, timed_out: true, duration_ms: Date.now() - start };
    return { cmd: command, cwd, exit_code: null, stdout: '', stderr: HELD, success: false, denied: true,
      ...(combined?.aborted ? { cancelled: true } : {}), duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer); clearInterval(monitor);
    if (temporary) {
      const restoreDirectoryAccess = async (path: string): Promise<void> => {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        await chmod(path, (stat.mode & 0o777) | 0o700);
        for (const name of await readdir(path)) await restoreDirectoryAccess(join(path, name));
      };
      await restoreDirectoryAccess(temporary);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
