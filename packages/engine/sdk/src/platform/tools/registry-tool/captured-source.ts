/** Original-owner registry inputs, admitted by the host, never by model paths. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority, contractInputAuthoritySourceRoot, registerContractInputReadAssertion,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import type { RegistryToolSource } from './source.js';

export interface CapturedRegistryContext { readonly kind: 'captured-registry-context' }
export interface CapturedRegistryBinding {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
}
interface CapturedFile { readonly data: string; readonly fingerprint: string }
interface Admission {
  readonly authority: ContractInputAuthority;
  readonly workingDirectory: string;
  readonly homeDirectory: string | undefined;
  readonly source: (signal?: AbortSignal) => RegistryToolSource;
}
const admissions = new WeakMap<CapturedRegistryContext, Admission>();
const fingerprint = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
const identity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const contained = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

/**
 * Configured home is a host declaration, not a grant; every file uses the pinned host filter.
 * Capture only .goodvibes/{skills,agents} below the admitted owner/configured home.
 * Other .goodvibes paths and symlinks remain unavailable. Included files may have
 * any extension, but an excluded/restricted/out-of-scope include holds content.
 * Each context is bounded to 2,048 files/directories, depth 16, 1 MiB per file and
 * 8 MiB total; a larger context fails admission rather than returning partial data.
 */
export async function admitCapturedRegistryContext(
  binding: CapturedRegistryBinding,
  roots: { readonly homeDirectory?: string | undefined } = {},
): Promise<CapturedRegistryContext> {
  binding = Object.freeze({ authority: binding.authority, root: resolve(binding.root), readAccessFilter: binding.readAccessFilter, signal: binding.signal });
  // Capture all caller-owned inputs before the first callback/await.
  const homeDirectory = roots.homeDirectory === undefined ? undefined : resolve(roots.homeDirectory);
  const workingDirectory = contractInputAuthoritySourceRoot(binding.authority);
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('registry input requires original-owner read authorization');
  const owners = [...new Set([workingDirectory, ...(homeDirectory === undefined ? [] : [homeDirectory])])];
  const declared = owners.flatMap((root) => ['skills', 'agents'].map((kind) => join(root, '.goodvibes', kind)));
  const files = new Map<string, CapturedFile>();
  const directories = new Map<string, readonly string[]>();
  const directoryIdentities = new Map<string, string>();
  const used = new Set<string>();
  const withheld = new Set<string>();
  let bytes = 0;
  const inScope = (path: string): boolean => declared.some((root) => contained(root, path) &&
    !relative(root, path).split(sep).some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number])));
  const checkPath = (path: string): void => {
    if (!inScope(path) || realpathSync(path) !== path) throw new Error('registry source is outside its admitted roots or redirected');
    for (const [directory, expected] of directoryIdentities) {
      if (!contained(directory, path)) continue;
      const stat = lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected)
        throw new Error('registry source directory identity changed');
    }
    const file = files.get(path);
    if (file && fingerprint(lstatSync(path, { bigint: true })) !== file.fingerprint)
      throw new Error('registry source changed after admission');
  };
  const checkAuthority = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
    signal?.throwIfAborted();
  };
  const checkRead = async (path: string, signal?: AbortSignal): Promise<void> => {
    await checkAuthority(signal);
    checkPath(path);
    if (!await filter(path)) throw new Error('registry source is access-restricted');
    await checkAuthority(signal);
    checkPath(path);
  };
  const checkUsed = async (signal?: AbortSignal): Promise<void> => {
    await checkAuthority(signal);
    for (const path of used) await checkRead(path, signal);
  };
  const visit = async (path: string, depth: number): Promise<void> => {
    if (!inScope(path)) { withheld.add(path); return; }
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || realpathSync(path) !== path) { withheld.add(path); return; }
    if (!await filter(path)) { withheld.add(path); return; }
    await checkAuthority();
    checkPath(path);
    if (stat.isDirectory()) {
      if (depth > 16 || directories.size >= 2048) throw new Error('registry input exceeds directory limit');
      directoryIdentities.set(path, identity(stat));
      const entries = readdirSync(path).sort();
      directories.set(path, Object.freeze(entries));
      for (const entry of entries) await visit(join(path, entry), depth + 1);
    } else if (stat.isFile()) {
      if (files.size >= 2048 || stat.size > 1024n * 1024n || bytes + Number(stat.size) > 8 * 1024 * 1024)
        throw new Error('registry input exceeds byte/file limit');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: string;
      try {
        if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(stat)) throw new Error('registry source changed during capture');
        checkPath(path);
        data = readFileSync(fd, 'utf8');
        if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(stat)) throw new Error('registry source changed during capture');
      } finally { closeSync(fd); }
      files.set(path, { data, fingerprint: fingerprint(stat) });
      bytes += Buffer.byteLength(data);
      if (bytes > 8 * 1024 * 1024) throw new Error('registry input exceeds byte limit');
      await checkRead(path);
    }
  };
  await checkAuthority();
  for (const directory of declared) await visit(directory, 0);
  await checkAuthority();
  const token = Object.freeze({ kind: 'captured-registry-context' as const });
  admissions.set(token, Object.freeze({
    authority: binding.authority, workingDirectory, homeDirectory,
    source: (signal) => ({
      signal: binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : (binding.signal ?? signal),
      exists: async (raw) => { await checkAuthority(signal); return files.has(resolve(raw)) || directories.has(resolve(raw)); },
      includeExists: async (raw) => {
        await checkAuthority(signal);
        const path = resolve(raw);
        if (!inScope(path) || [...withheld].some((blocked) => contained(blocked, path)))
          throw new Error('registry include was not admitted; content is withheld');
        return files.has(path) || directories.has(path);
      },
      list: async (raw) => {
        const path = resolve(raw);
        used.add(path);
        await checkRead(path, signal);
        const entries = directories.get(path);
        if (!entries) throw new Error('registry directory was not admitted');
        return entries;
      },
      read: async (raw) => {
        const path = resolve(raw);
        const file = files.get(path);
        if (!file) throw new Error('registry file was not admitted');
        used.add(path);
        await checkRead(path, signal);
        return file.data;
      },
      assertCurrent: () => checkUsed(signal),
    }),
  }));
  // Cached registry-derived messages are checked before every later model request.
  registerContractInputReadAssertion(binding.authority, () => checkUsed());
  return token;
}

export function capturedRegistryAdmission(context: CapturedRegistryContext): Admission {
  const state = admissions.get(context);
  if (!state) throw new Error('registry input has no construction-owned admission');
  return state;
}
