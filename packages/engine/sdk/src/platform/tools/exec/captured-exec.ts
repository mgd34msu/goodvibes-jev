import { projectCapturedExecDependencies, type CapturedExecDependencyInput } from './captured-exec-dependencies.js';
/** Commands see a permission-filtered disposable copy, never the host workspace.
 * This is a filesystem boundary, not another command/risk/retry evaluator.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import type { ExecCommandInput, ExecCommandResult } from './schema.js';

export interface CapturedExecAuthority {
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
function runtimeArgv(): string[] {
  const argv = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
    '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib'];
  if (existsSync('/usr/lib64')) argv.push('--ro-bind', '/usr/lib64', '/usr/lib64', '--symlink', 'usr/lib64', '/lib64');
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/captured',
    '--ro-bind', process.execPath, `/captured-runtime/bin/${process.versions.bun ? 'bun' : 'node'}`);
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
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export async function runCapturedCommand(
  binding: CapturedExecAuthority,
  command: string,
  input: ExecCommandInput,
  workingDirectory: string,
  timeoutMs: number,
  signal?: AbortSignal,
  network: 'enabled' | 'disabled' = 'disabled',
): Promise<ExecCommandResult> {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  input = structuredClone(input);
  const start = Date.now();
  const root = resolve(binding.root);
  const cwd = resolve(workingDirectory, input.cwd ?? '.');
  const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  let temporary: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let killed = false;
  let timedOut = false;
  let invalid = false;
  let validation: Promise<void> = Promise.resolve();
  let validating = false;
  let stop = (): void => {};
  const paths = new Set<string>();
  let checkDependencies = async (): Promise<void> => {};
  const check = async (): Promise<void> => {
    if (!binding.readAccessFilter) throw new Error('captured exec requires original-owner read authorization');
    await assertContractInputAuthority(binding.authority, root, combined);
    for (const path of paths) await authorizeContractInputPath(binding.authority, path, binding.readAccessFilter, combined);
    await checkDependencies();
  };
  try {
    if (!within(root, resolve(workingDirectory)) || !within(root, cwd)) throw new Error('outside captured working directory');
    if (['/usr', '/bin', '/lib', '/lib64', '/proc', '/dev'].some((path) => within(path, root) || within(root, path)))
      throw new Error('captured root overlaps runtime mounts');
    if (input.background || input.until || input.interactive) throw new Error('captured exec requires a bounded foreground command');
    await check();
    const availability = await probeCapturedExecAvailability();
    await check();
    if (!availability.available) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: availability.message, success: false, denied: true,
      sandboxed: false, sandbox_boundary: 'captured boundary unavailable', captured_exec_availability: availability, duration_ms: Date.now() - start };
    if (cwd !== root) await authorizeContractInputPath(binding.authority, cwd, binding.readAccessFilter, combined);
    temporary = await mkdtemp(join(tmpdir(), 'goodvibes-captured-exec-'));
    const projection = join(temporary, 'view');
    await mkdir(projection);
    const originals = new Map<string, { data: Buffer; mode: number }>();
    let bytes = 0;
    const populate = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        if (CONTRACT_INPUT_EXCLUSIONS.includes(entry.name as typeof CONTRACT_INPUT_EXCLUSIONS[number])) continue;
        const rel = join(dir, entry.name);
        const source = join(root, rel);
        try { await authorizeContractInputPath(binding.authority, source, binding.readAccessFilter, combined); }
        catch { await assertContractInputAuthority(binding.authority, root, combined); continue; }
        const stat = await lstat(source);
        if (stat.isDirectory()) { await mkdir(join(projection, rel), { recursive: true }); await populate(rel); }
        else if (stat.isFile() && !stat.isSymbolicLink()) {
          if (stat.size > 32 * 1024 * 1024 || bytes + stat.size > MAX_BYTES) throw new Error('captured input exceeds byte limit');
          const data = await readFile(source);
          await authorizeContractInputPath(binding.authority, source, binding.readAccessFilter, combined);
          paths.add(source);
          bytes += data.length;
          if (originals.size >= MAX_FILES || bytes > MAX_BYTES) throw new Error('captured projection exceeds resource limit');
          originals.set(rel, { data, mode: stat.mode & 0o777 });
          await writeFile(join(projection, rel), data, { mode: stat.mode & 0o777 });
        }
      }
    };
    await populate('');
    const dependencies = await projectCapturedExecDependencies(binding, temporary, combined);
    checkDependencies = dependencies.check;
    await check();
    const filterPath = join(temporary, 'sockets.bpf');
    await writeFile(filterPath, socketFilter(network));
    const fd = openSync(filterPath, 'r');
    const argv = runtimeArgv();
    argv.push(contractInputAuthorityMutable(binding.authority) ? '--bind' : '--ro-bind', projection, root,
      '--chdir', cwd, '--seccomp', '3');
    for (const mount of dependencies.mounts) argv.push('--ro-bind', mount.source, mount.target);
    argv.push('--', '/bin/sh', '-c', command);
    let child: ReturnType<typeof spawn>;
    try {
      combined?.throwIfAborted();
      child = spawn('/usr/bin/bwrap', argv, {
        env: { PATH: '/captured-runtime/bin:/usr/bin:/bin', HOME: '/home/captured', TMPDIR: '/tmp', LANG: 'C.UTF-8', ...input.env },
        stdio: ['ignore', 'pipe', 'pipe', fd],
      });
    } finally { closeSync(fd); }
    stop = () => { killed = true; child.kill('SIGKILL'); };
    const onAbort = (): void => { invalid = true; stop(); };
    combined?.addEventListener('abort', onAbort, { once: true });
    if (combined?.aborted) onAbort();
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    monitor = setInterval(() => {
      if (validating) return;
      validating = true;
      validation = check().catch(() => { invalid = true; stop(); }).finally(() => { validating = false; });
    }, 50);
    let stdout = ''; let stderr = '';
    const capture = (data: Buffer, output: 'stdout' | 'stderr'): void => {
      if (output === 'stdout') stdout += data.toString(); else stderr += data.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT) { invalid = true; stop(); }
    };
    child.stdout!.on('data', (data: Buffer) => capture(data, 'stdout'));
    child.stderr!.on('data', (data: Buffer) => capture(data, 'stderr'));
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('close', resolveExit);
    }).finally(() => { clearInterval(monitor); clearTimeout(timer); combined?.removeEventListener('abort', onAbort); });
    await validation;
    await check();
    if (invalid) throw new Error('authority changed');
    if (killed) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: '', success: false, timed_out: timedOut, duration_ms: Date.now() - start };
    const changes = new Map<string, { data: Buffer; mode: number }>();
    const present = new Set<string>();
    let resultBytes = 0;
    const inspect = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(projection, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        const target = join(root, rel);
        await authorizeContractInputPath(binding.authority, target, binding.readAccessFilter, combined);
        paths.add(target);
        const stat = await lstat(join(projection, rel));
        if (stat.isDirectory()) await inspect(rel);
        else if (stat.isFile() && !stat.isSymbolicLink()) {
          if (stat.size > 32 * 1024 * 1024 || resultBytes + stat.size > MAX_BYTES) throw new Error('captured output exceeds byte limit');
          const data = await readFile(join(projection, rel));
          resultBytes += data.length;
          if (present.size >= MAX_FILES || resultBytes > MAX_BYTES) throw new Error('captured output exceeds resource limit');
          present.add(rel);
          const previous = originals.get(rel);
          if (!previous?.data.equals(data) || previous.mode !== (stat.mode & 0o777)) changes.set(rel, { data, mode: stat.mode & 0o777 });
        } else throw new Error('captured output contains an alias or special file');
      }
    };
    await inspect('');
    await check();
    if (contractInputAuthorityMutable(binding.authority)) {
      for (const [rel, { data, mode }] of changes) {
        const target = await authorizeContractInputPath(binding.authority, join(root, rel), binding.readAccessFilter, combined);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, data, { mode }); await chmod(target, mode);
      }
      for (const rel of originals.keys()) if (!present.has(rel)) {
        const target = await authorizeContractInputPath(binding.authority, join(root, rel), binding.readAccessFilter, combined);
        await rm(target);
      }
    }
    await check();
    const failures: string[] = [];
    if (input.expect?.exit_code !== undefined && exitCode !== input.expect.exit_code) failures.push('exit_code expectation failed');
    if (input.expect?.stdout_contains !== undefined && !stdout.includes(input.expect.stdout_contains)) failures.push('stdout expectation failed');
    if (input.expect?.stderr_contains !== undefined && !stderr.includes(input.expect.stderr_contains)) failures.push('stderr expectation failed');
    return { cmd: command, cwd, exit_code: exitCode, stdout, stderr, success: exitCode === 0 && failures.length === 0,
      duration_ms: Date.now() - start, sandboxed: true, sandbox_boundary: `captured authorized projection; isolated PID/mounts; network ${network}`, sandbox_network: network,
      captured_exec_availability: availability, ...(failures.length ? { expectation_error: failures.join('; ') } : {}) };
  } catch {
    stop();
    return { cmd: command, cwd, exit_code: null, stdout: '', stderr: HELD, success: false, denied: true,
      ...(combined?.aborted ? { cancelled: true } : {}), duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer); clearInterval(monitor);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
