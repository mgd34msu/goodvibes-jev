import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** Trusted runtime declarations are separate from model arguments and project dependencies. */
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { assertContractInputAuthority, registerContractInputReadAssertion } from '../../contract/input-authority.js';
import type { CapturedExecAuthority } from './captured-exec.js';

type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal'>;
export interface CapturedExecNodeRuntimeDeclaration {
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly npxExecutable: string;
}
export interface CapturedExecNodeRuntimeInput { readonly kind: 'captured-exec-node-runtime' }
const TARGET = '/captured-runtime/node';
const states = new WeakMap<CapturedExecNodeRuntimeInput, {
  binding: Binding; files: readonly { path: string; data: Buffer; mode: number }[]; check: (signal?: AbortSignal) => Promise<void>;
}>();
const identity = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
async function executable(name: string, path: string): Promise<string> {
  for (const directory of path.split(sep === '/' ? ':' : ';')) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Next trusted PATH entry. */ }
  }
  throw new Error(`Captured validators require an installed ${name} executable on the trusted runtime PATH.`);
}

/** Call only during trusted construction. Never accept this declaration from tool JSON. */
export async function admitCapturedExecNodeRuntime(
  binding: Binding,
  declaration?: CapturedExecNodeRuntimeDeclaration,
): Promise<CapturedExecNodeRuntimeInput> {
  binding = Object.freeze({ ...binding });
  declaration = declaration ? Object.freeze({ ...declaration }) : undefined;
  const trustedPath = process.env.PATH ?? '';
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('Node runtime requires original-owner read authorization');
  await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
  const declared = declaration ?? {
    nodeExecutable: await executable('node', trustedPath),
    npmExecutable: await executable('npm', trustedPath),
    npxExecutable: await executable('npx', trustedPath),
  };
  if (Object.values(declared).some((path) => !isAbsolute(path))) throw new Error('Node runtime declarations must be absolute');
  const node = await realpath(declared.nodeExecutable);
  const npm = await realpath(declared.npmExecutable);
  const npx = await realpath(declared.npxExecutable);
  const packageRoot = dirname(dirname(npm));
  if (npm !== join(packageRoot, 'bin/npm-cli.js') || npx !== join(packageRoot, 'bin/npx-cli.js'))
    throw new Error('Node runtime npm/npx must belong to the same declared npm package');
  const reads: { source: string; canonical: string; alias: string; identity: string }[] = [];
  const files: { path: string; data: Buffer; mode: number }[] = [];
  const checkRead = async (read: typeof reads[number], signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal?.throwIfAborted();
    if (!await executePolicyCheck(() => filter(read.source), signal) || !await executePolicyCheck(() => filter(read.canonical), signal) || !await executePolicyCheck(() => filter(read.alias), signal))
      throw new Error('Node runtime input is access-restricted');
    if (await realpath(read.source) !== read.canonical || identity(await lstat(read.canonical, { bigint: true })) !== read.identity)
      throw new Error('Node runtime input changed after admission');
    signal?.throwIfAborted();
  };
  const check = async (signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
    await assertContractInputAuthority(binding.authority, binding.root, signal);
    for (const read of reads) await checkRead(read, signal);
    await assertContractInputAuthority(binding.authority, binding.root, signal);
  };
  let bytes = 0;
  const visit = async (source: string, path: string, root: string): Promise<void> => {
    if ((await lstat(source)).isSymbolicLink()) throw new Error('Node runtime package symlinks are unsupported');
    const canonical = await realpath(source);
    if (!within(root, canonical)) throw new Error('Node runtime path escapes declared package');
    const stat = await lstat(canonical, { bigint: true });
    const read = { source, canonical, alias: join(TARGET, path), identity: identity(stat) };
    await checkRead(read);
    reads.push(read);
    if (stat.isDirectory()) {
      for (const entry of await readdir(canonical)) await visit(join(source, entry), join(path, entry), root);
    } else if (stat.isFile()) {
      if (files.length >= 10000 || Number(stat.size) + bytes > 256 * 1024 * 1024) throw new Error('Node runtime exceeds bounded input size');
      const data = await readFile(canonical);
      await checkRead(read);
      bytes += data.length;
      files.push({ path, data, mode: Number(stat.mode & 0o777n) });
    } else throw new Error('Node runtime special file is unsupported');
  };
  // Pin command aliases as well as their canonical payloads.
  for (const [source, canonical, alias] of [
    [declared.nodeExecutable, node, '/captured-runtime/bin/node'],
    [declared.npmExecutable, npm, '/captured-runtime/bin/npm'],
    [declared.npxExecutable, npx, '/captured-runtime/bin/npx'],
  ] as const) {
    const read = { source, canonical, alias, identity: identity(await lstat(canonical, { bigint: true })) };
    await checkRead(read); reads.push(read);
  }
  await visit(node, 'bin/node', node);
  // npm's implementation and bundled runtime dependencies only: no global config,
  // user npmrc, cache, docs, man pages or sibling globally installed packages.
  for (const part of ['package.json', 'index.js', 'bin', 'lib', 'node_modules'])
    await visit(join(packageRoot, part), join('lib/node_modules/npm', part), packageRoot);
  const metadata = JSON.parse(files.find((file) => file.path === 'lib/node_modules/npm/package.json')!.data.toString()) as { name?: string };
  if (metadata.name !== 'npm') throw new Error('Declared runtime package is not npm');
  await check();
  const token = Object.freeze({ kind: 'captured-exec-node-runtime' as const });
  states.set(token, { binding, files, check });
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

export async function projectCapturedExecNodeRuntime(binding: CapturedExecAuthority, temporary: string, signal?: AbortSignal): Promise<{
  argv: string[]; check: (signal?: AbortSignal) => Promise<void>;
}> {
  if (!binding.nodeRuntimeInput) return { argv: [], check: async () => {} };
  const state = states.get(binding.nodeRuntimeInput);
  if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
    throw new Error('Node runtime has no matching construction-owned admission');
  signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  await state.check(signal);
  const staged = join(temporary, 'node-runtime');
  for (const file of state.files) {
    signal?.throwIfAborted();
    const path = join(staged, file.path);
    await mkdir(dirname(path), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(path, file.data, { mode: file.mode });
    signal?.throwIfAborted();
    await chmod(path, file.mode);
  }
  await state.check(signal);
  return { check: () => state.check(signal), argv: ['--ro-bind', staged, TARGET,
    '--symlink', `${TARGET}/bin/node`, '/captured-runtime/bin/node',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npm-cli.js`, '/captured-runtime/bin/npm',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npx-cli.js`, '/captured-runtime/bin/npx'] };
}
