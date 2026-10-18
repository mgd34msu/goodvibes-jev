import { fileContentDigest } from '../../utils/file-content.js';
import { checkCapturedInputsInBatches } from './captured-exec-validation.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** Trusted runtime declarations are separate from model arguments and project dependencies. */
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertContractInputAuthority, contractInputAuthorityRoot, registerContractInputReadAssertion, withContractInputReadBatch } from '../../contract/input-authority.js';
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
  binding: Binding; files: readonly { path: string; source: string; digest: string; mode: number }[]; check: (signal?: AbortSignal) => Promise<void>;
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

/** Captured commands and validators can defer runtime bytes until execution.
 * PATH resolution and executable identities are pinned synchronously at construction.
 * A failed/cancelled first admission is terminal; this is not another retry loop.
 */
export function createCapturedExecNodeRuntimeAdmission(
  binding: Binding,
  declaration?: CapturedExecNodeRuntimeDeclaration,
): (signal?: AbortSignal) => Promise<CapturedExecNodeRuntimeInput> {
  binding = Object.freeze({ ...binding });
  const trustedPath = process.env.PATH ?? '';
  let pinned: CapturedExecNodeRuntimeDeclaration | undefined;
  let initialError: unknown;
  let identities: readonly { source: string; canonical: string; identity: string }[] = [];
  try {
    const find = (name: string): string => {
      for (const directory of trustedPath.split(sep === '/' ? ':' : ';')) {
        if (!isAbsolute(directory)) continue;
        const candidate = join(directory, name);
        try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Next trusted entry. */ }
      }
      throw new Error(`Captured validators require an installed ${name} executable on the trusted runtime PATH.`);
    };
    pinned = Object.freeze(declaration ? { ...declaration } : {
      nodeExecutable: find('node'), npmExecutable: find('npm'), npxExecutable: find('npx'),
    });
    identities = Object.values(pinned).map((source) => {
      if (!isAbsolute(source)) throw new Error('Node runtime declarations must be absolute');
      const canonical = realpathSync(source);
      return { source, canonical, identity: identity(lstatSync(canonical, { bigint: true })) };
    });
  } catch (error) { initialError = error; }
  const checkPinned = (): void => {
    for (const read of identities) {
      if (realpathSync(read.source) !== read.canonical || identity(lstatSync(read.canonical, { bigint: true })) !== read.identity)
        throw new Error('Node runtime executable changed since trusted construction');
    }
  };
  let admission: Promise<CapturedExecNodeRuntimeInput> | undefined;
  return (signal?: AbortSignal) => {
    admission ??= (async () => {
      if (initialError) throw initialError;
      if (!pinned) throw new Error('Node runtime declaration is unavailable');
      const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
      combined?.throwIfAborted();
      checkPinned();
      const token = await admitCapturedExecNodeRuntime({ ...binding, signal: combined }, pinned);
      checkPinned();
      combined?.throwIfAborted();
      return token;
    })();
    return executePolicyCheck(() => admission!, signal);
  };
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
  const files: { path: string; source: string; digest: string; mode: number }[] = [];
  const checkRead = async (read: typeof reads[number], signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal?.throwIfAborted();
    if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('Node runtime authority changed');
    if (!await executePolicyCheck(() => filter(read.source), signal) || !await executePolicyCheck(() => filter(read.canonical), signal) || !await executePolicyCheck(() => filter(read.alias), signal))
      throw new Error('Node runtime input is access-restricted');
    if (await realpath(read.source) !== read.canonical || identity(await lstat(read.canonical, { bigint: true })) !== read.identity)
      throw new Error('Node runtime input changed after admission');
    signal?.throwIfAborted();
  };
  const check = async (signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
    await withContractInputReadBatch(binding.authority, async () => {
      await assertContractInputAuthority(binding.authority, binding.root, signal);
      await checkCapturedInputsInBatches(reads, (read, current) => checkRead(read, current), signal);
      await assertContractInputAuthority(binding.authority, binding.root, signal);
    });
  };
  const visit = async (source: string, path: string, root: string): Promise<void> => {
    const aliasStat = await lstat(source);
    const canonical = await realpath(source);
    if (!within(root, canonical)) throw new Error('Node runtime paths and symlinks may not escape the declared package');
    const stat = await lstat(canonical, { bigint: true });
    // npm ships .bin aliases to its bundled files. Capture their authorized
    // bytes under the alias path; directory links remain unsupported. Both the
    // alias and canonical identity are rechecked before execution.
    if (aliasStat.isSymbolicLink() && !stat.isFile()) throw new Error('Node runtime directory symlinks are unsupported');
    const read = { source, canonical, alias: join(TARGET, path), identity: identity(stat) };
    await checkRead(read);
    reads.push(read);
    if (stat.isDirectory()) {
      for (const entry of await readdir(canonical)) await visit(join(source, entry), join(path, entry), root);
    } else if (stat.isFile()) {
      const digest = await fileContentDigest(canonical, binding.signal);
      await checkRead(read);
      files.push({ path, source: canonical, digest, mode: Number(stat.mode & 0o777n) });
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
  const metadata = JSON.parse(await readFile(files.find((file) => file.path === 'lib/node_modules/npm/package.json')!.source, 'utf8')) as { name?: string };
  if (metadata.name !== 'npm') throw new Error('Declared runtime package is not npm');
  await check();
  const token = Object.freeze({ kind: 'captured-exec-node-runtime' as const });
  states.set(token, { binding, files, check });
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

/** Replace only the existing OS command aliases, never mount another runtime tree. */
function blockedSystemRuntimeAliases(refusal: string): string[] {
  const argv: string[] = [];
  const targets = new Set<string>();
  for (const name of ['node', 'nodejs', 'npm', 'npx']) {
    const alias = `/usr/bin/${name}`;
    if (!existsSync(alias)) continue;
    const target = realpathSync(alias);
    if (!['/usr/bin', '/usr/lib', '/usr/lib64'].some((root) => within(root, target)) || targets.has(target)) continue;
    targets.add(target);
    argv.push('--ro-bind', refusal, target);
  }
  return argv;
}

export async function projectCapturedExecNodeRuntime(binding: CapturedExecAuthority, temporary: string, signal?: AbortSignal): Promise<{
  argv: string[]; check: (signal?: AbortSignal) => Promise<void>;
}> {
  if (!binding.nodeRuntimeInput && !binding.nodeRuntimeAdmission) return { argv: [], check: async () => {} };
  signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  signal?.throwIfAborted();
  // Only the admitted /captured-runtime aliases carry runtime authority. Never
  // fall through to a different Node/npm installation in the OS substrate.
  const refusal = join(temporary, 'node-runtime-unavailable');
  await writeFile(refusal, '#!/bin/sh\nprintf "%s\\n" "Captured Node/npm runtime is unavailable or access-restricted." >&2\nexit 126\n', { mode: 0o755 });
  signal?.throwIfAborted();
  await chmod(refusal, 0o755);
  signal?.throwIfAborted();
  if (!binding.nodeRuntimeInput) {
    return { check: async () => {}, argv: [
      ...['node', 'npm', 'npx'].flatMap((name) => ['--ro-bind', refusal, `/captured-runtime/bin/${name}`]),
      ...blockedSystemRuntimeAliases(refusal),
    ] };
  }
  const state = states.get(binding.nodeRuntimeInput);
  if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
    throw new Error('Node runtime has no matching construction-owned admission');
  await state.check(signal);
  const staged = join(temporary, 'node-runtime');
  for (const file of state.files) {
    signal?.throwIfAborted();
    const path = join(staged, file.path);
    await mkdir(dirname(path), { recursive: true });
    signal?.throwIfAborted();
    await copyFile(file.source, path, constants.COPYFILE_EXCL);
    if (await fileContentDigest(path, signal) !== file.digest) throw new Error('Node runtime input changed during projection');
    signal?.throwIfAborted();
    await chmod(path, file.mode);
  }
  await state.check(signal);
  return { check: () => state.check(signal), argv: ['--ro-bind', staged, TARGET,
    '--symlink', `${TARGET}/bin/node`, '/captured-runtime/bin/node',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npm-cli.js`, '/captured-runtime/bin/npm',
    '--symlink', `${TARGET}/lib/node_modules/npm/bin/npx-cli.js`, '/captured-runtime/bin/npx',
    ...blockedSystemRuntimeAliases(refusal)] };
}
