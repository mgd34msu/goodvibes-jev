/** Construction-admitted immutable dependency inputs. No prefix is a read grant. */
import { lstat, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthoritySourceRoot,
  contractInputAuthorityRoot,
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
interface WorkspaceLink {
  readonly source: string;
  readonly canonical: string;
  readonly captured: string;
  readonly alias: string;
  readonly path: string;
  readonly identity: string;
}
interface Admission {
  readonly binding: Binding;
  readonly target: string;
  readonly files: readonly { path: string; data: Buffer; mode: number }[];
  readonly workspaceLinks: readonly WorkspaceLink[];
  readonly fileLinks: readonly { path: string; target: string }[];
  readonly checkWorkspaceRead: (captured: string, originalAlias: string, projectedAlias: string) => Promise<void>;
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
  const checkRoot = async (full = true): Promise<void> => {
    binding.signal?.throwIfAborted();
    if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('dependency authority root changed');
    if (full) await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
    const stat = await lstat(sourceRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot || `${stat.dev}:${stat.ino}` !== rootIdentity)
      throw new Error('dependency source root changed');
  };
  const workspaceLinks: WorkspaceLink[] = [];
  const fileLinks: { path: string; target: string }[] = [];
  const workspaceReads = new Map<string, readonly [string, string, string]>();
  const checkWorkspaceRead = async (captured: string, originalAlias: string, projectedAlias: string): Promise<void> => {
    await authorizeContractInputPath(binding.authority, captured, filter, binding.signal);
    if (!await filter(originalAlias) || !await filter(projectedAlias)) throw new Error('workspace dependency alias is access-restricted');
    await checkRoot();
    workspaceReads.set(`${captured}\0${projectedAlias}`, [captured, originalAlias, projectedAlias]);
  };
  const reads: DependencyRead[] = [];
  const files: { path: string; data: Buffer; mode: number }[] = [];
  const checkRead = async (read: DependencyRead, full = true): Promise<void> => {
    binding.signal?.throwIfAborted();
    if (!await filter(read.source) || !await filter(read.canonical) || !await filter(read.alias)) throw new Error('dependency input is access-restricted');
    await checkRoot(full);
    if (await realpath(read.source) !== read.canonical || fingerprint(await lstat(read.canonical, { bigint: true })) !== read.identity)
      throw new Error('dependency source changed after admission');
  };
  const check = async (): Promise<void> => {
    await checkRoot();
    // This metadata-only sweep never releases bytes or grants another operation.
    // Full recorded-view/Git validation brackets it; each entry still checks
    // the live opaque token, source-root identity, current original/alias
    // permissions and immutable file identity. Admission byte reads use the
    // full checkRead default before their bytes can enter the admitted input.
    for (const read of reads) await checkRead(read, false);
    for (const link of workspaceLinks) {
      if (fingerprint(await lstat(link.source, { bigint: true })) !== link.identity || await realpath(link.source) !== link.canonical)
        throw new Error('workspace dependency link changed after admission');
      await checkWorkspaceRead(link.captured, link.source, link.alias);
    }
    for (const read of workspaceReads.values()) await checkWorkspaceRead(...read);
    await checkRoot();
  };
  let bytes = 0;
  const visit = async (source: string, alias: string, path: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const canonical = await realpath(source);
    if (!contained(sourceRoot, canonical)) {
      const ownerRelative = relative(owner, canonical);
      const linkStat = await lstat(source, { bigint: true });
      if (!ownerRelative || !contained(owner, canonical) || excluded(ownerRelative) || !linkStat.isSymbolicLink())
        throw new Error('dependency alias escapes declared input');
      const captured = resolve(binding.root, ownerRelative);
      // The original target supplies mapping metadata only. Its current bytes
      // are never opened: the same authority must already hold a captured target.
      await checkWorkspaceRead(captured, source, alias);
      const capturedStat = await lstat(captured);
      if (!capturedStat.isFile() && !capturedStat.isDirectory()) throw new Error('workspace dependency target is not captured');
      workspaceLinks.push({ source, canonical, captured, alias, path, identity: fingerprint(linkStat) });
      return;
    }
    if (excluded(relative(sourceRoot, canonical))) throw new Error('dependency alias escapes declared input');
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
      if ((await lstat(source)).isSymbolicLink()) fileLinks.push({ path, target: relative(sourceRoot, canonical) });
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
  admissions.set(token, { binding, target, files, workspaceLinks, fileLinks, checkWorkspaceRead, check });
  // Future provider delivery rechecks cached dependency-derived output too.
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

export async function projectCapturedExecDependencies(
  binding: CapturedExecAuthority,
  temporary: string,
  signal: AbortSignal | undefined,
  capturedProjection: string,
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
    let workspaceBytes = 0;
    let workspaceCount = 0;
    const copyWorkspace = async (link: WorkspaceLink, suffix: string): Promise<void> => {
      signal?.throwIfAborted();
      const captured = join(link.captured, suffix);
      const originalAlias = join(link.source, suffix);
      const projectedAlias = join(link.alias, suffix);
      await state.checkWorkspaceRead(captured, originalAlias, projectedAlias);
      const input = join(capturedProjection, relative(binding.root, captured));
      const stat = await lstat(input);
      const destination = join(staged, link.path, suffix);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await mkdir(destination, { recursive: true });
        for (const entry of await readdir(input)) await copyWorkspace(link, join(suffix, entry));
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (++workspaceCount > 20_000 || stat.size > 32 * 1024 * 1024 || workspaceBytes + stat.size > 256 * 1024 * 1024)
          throw new Error('workspace dependency exceeds resource limit');
        const data = await readFile(input);
        workspaceBytes += data.length;
        await state.checkWorkspaceRead(captured, originalAlias, projectedAlias);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, data, { mode: stat.mode & 0o777 });
      } else throw new Error('workspace dependency projection contains an unsupported alias');
    };
    for (const link of state.workspaceLinks) await copyWorkspace(link, '');
    // Preserve executable file aliases so Node resolves relative imports from
    // the admitted canonical package. Directory aliases remain filtered copies:
    // linking them could expose a child denied under the alias path.
    for (const link of state.fileLinks) {
      if (!state.files.some((file) => file.path === link.target)) throw new Error('dependency executable alias target is not admitted');
      await unlink(join(staged, link.path));
      await symlink(relative(dirname(link.path), link.target), join(staged, link.path));
    }
    mounts.push({ source: staged, target: state.target });
  }
  await check();
  return { mounts, check };
}
