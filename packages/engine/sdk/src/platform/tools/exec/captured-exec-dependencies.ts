/** Construction-admitted immutable dependency inputs. No prefix is a read grant. */
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  contractInputAuthoritySourceRoot,
  registerContractInputReadAssertion,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { CapturedExecAuthority } from './captured-exec.js';

export interface CapturedExecDependencyRoot {
  readonly sourceRoot: string;
  readonly targetRelativePath: string;
}
/** Serialization or model arguments cannot manufacture an admitted input. */
export interface CapturedExecDependencyInput { readonly kind: 'captured-exec-dependency-input' }
type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal'>;
interface DependencyRead {
  readonly source: string;
  readonly canonical: string;
  readonly alias: string;
  readonly identity: string;
}
interface Admission {
  readonly binding: Binding;
  readonly target: string;
  readonly files: readonly { path: string; data: Buffer; mode: number }[];
  readonly check: () => Promise<void>;
}
const admissions = new WeakMap<CapturedExecDependencyInput, Admission>();
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function excluded(path: string): boolean {
  return path.split(sep).some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number]));
}
const fingerprint = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;

export async function admitCapturedExecDependency(
  binding: Binding,
  declaration: CapturedExecDependencyRoot,
): Promise<CapturedExecDependencyInput | undefined> {
  binding = Object.freeze({ ...binding });
  declaration = Object.freeze({ ...declaration });
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('dependency input requires original-owner read authorization');
  await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
  const owner = contractInputAuthoritySourceRoot(binding.authority);
  const sourceRoot = resolve(declaration.sourceRoot);
  const rel = relative(owner, sourceRoot);
  const target = resolve(binding.root, declaration.targetRelativePath);
  if (!rel || !contained(owner, sourceRoot) || excluded(rel) || relative(binding.root, target) !== rel || !contained(binding.root, target))
    throw new Error('dependency declaration is outside admitted owner/view mapping');
  let rootStat;
  try { rootStat = await lstat(sourceRoot, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot)
    throw new Error('dependency source root is redirected');
  // Existing captured bytes always win over newer live dependency material.
  try { await lstat(target); return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
  const checkRoot = async (): Promise<void> => {
    await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
    const stat = await lstat(sourceRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot || `${stat.dev}:${stat.ino}` !== rootIdentity)
      throw new Error('dependency source root changed');
  };
  const reads: DependencyRead[] = [];
  const files: { path: string; data: Buffer; mode: number }[] = [];
  const checkRead = async (read: DependencyRead): Promise<void> => {
    binding.signal?.throwIfAborted();
    if (!await filter(read.source) || !await filter(read.canonical) || !await filter(read.alias)) throw new Error('dependency input is access-restricted');
    await checkRoot();
    if (await realpath(read.source) !== read.canonical || fingerprint(await lstat(read.canonical, { bigint: true })) !== read.identity)
      throw new Error('dependency source changed after admission');
  };
  const check = async (): Promise<void> => {
    await checkRoot();
    for (const read of reads) await checkRead(read);
  };
  let bytes = 0;
  const visit = async (source: string, alias: string, path: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const canonical = await realpath(source);
    if (!contained(sourceRoot, canonical) || excluded(relative(sourceRoot, canonical))) throw new Error('dependency alias escapes declared input');
    if (!await filter(source) || !await filter(canonical) || !await filter(alias)) return;
    await checkRoot();
    const stat = await lstat(canonical, { bigint: true });
    if (stat.isDirectory()) {
      reads.push({ source, canonical, alias, identity: fingerprint(stat) });
      if (ancestors.has(canonical)) throw new Error('cyclic dependency alias');
      const next = new Set(ancestors); next.add(canonical);
      for (const entry of await readdir(canonical)) {
        if (excluded(entry)) continue;
        await visit(join(source, entry), join(alias, entry), join(path, entry), next);
      }
    } else if (stat.isFile()) {
      if (files.length >= 20_000 || stat.size > 32n * 1024n * 1024n || bytes + Number(stat.size) > 256 * 1024 * 1024)
        throw new Error('dependency input exceeds resource limit');
      const read = { source, canonical, alias, identity: fingerprint(stat) };
      const data = await readFile(canonical);
      await checkRead(read);
      bytes += data.length;
      if (bytes > 256 * 1024 * 1024) throw new Error('dependency input exceeds byte limit');
      reads.push(read);
      files.push({ path, data, mode: Number(stat.mode & 0o777n) });
    } else throw new Error('dependency special-file input is unsupported');
  };
  await visit(sourceRoot, target, '', new Set());
  await check();
  const token = Object.freeze({ kind: 'captured-exec-dependency-input' as const });
  admissions.set(token, { binding, target, files, check });
  // Future provider delivery rechecks cached dependency-derived output too.
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

export async function projectCapturedExecDependencies(
  binding: CapturedExecAuthority,
  temporary: string,
  signal?: AbortSignal,
): Promise<{ readonly mounts: readonly { source: string; target: string }[]; readonly check: () => Promise<void> }> {
  const states: Admission[] = [];
  for (const token of binding.dependencyInputs ?? []) {
    const state = admissions.get(token);
    if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
      throw new Error('dependency input has no matching construction-owned admission');
    if (states.some((other) => contained(other.target, state.target) || contained(state.target, other.target)))
      throw new Error('dependency inputs overlap');
    states.push(state);
  }
  const check = async (): Promise<void> => {
    signal?.throwIfAborted();
    for (const state of states) await state.check();
    signal?.throwIfAborted();
  };
  await check();
  const mounts: { source: string; target: string }[] = [];
  for (const state of states) {
    const staged = join(temporary, `dependencies-${mounts.length}`);
    await mkdir(staged);
    for (const file of state.files) {
      signal?.throwIfAborted();
      const destination = join(staged, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data, { mode: file.mode });
    }
    mounts.push({ source: staged, target: state.target });
  }
  await check();
  return { mounts, check };
}
