/** Ordinary Bun is an explicit, pinned runtime input, never a PATH fallback. */
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { assertContractInputAuthority, contractInputAuthorityRoot, registerContractInputReadAssertion } from '../../contract/input-authority.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { probeCapturedBunRuntime, type CapturedExecAuthority } from './captured-exec.js';

type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal'>;
export interface CapturedExecBunRuntimeDeclaration { readonly bunExecutable: string }
export interface CapturedExecBunRuntimeInput { readonly kind: 'captured-exec-bun-runtime' }
const TARGET = '/captured-runtime/bin/bun';
const MAX_BYTES = 256 * 1024 * 1024;
const states = new WeakMap<CapturedExecBunRuntimeInput, {
  readonly binding: Binding;
  readonly data: Buffer;
  readonly mode: number;
  readonly check: (signal?: AbortSignal) => Promise<void>;
}>();
const identity = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;

/** Construction only. Source mode admits its running interpreter; compiled
 * products must supply their packaged ordinary Bun executable explicitly.
 * Missing, changed and failed first admissions are terminal for this owner.
 */
export function createCapturedExecBunRuntimeAdmission(
  binding: Binding,
  declaration?: CapturedExecBunRuntimeDeclaration,
): (signal?: AbortSignal) => Promise<CapturedExecBunRuntimeInput> {
  binding = Object.freeze({ ...binding });
  const source = declaration?.bunExecutable ?? process.execPath;
  let pinned: { canonical: string; identity: string } | undefined;
  let initialError: unknown;
  try {
    if (!isAbsolute(source)) throw new Error('Bun runtime declaration must be absolute');
    accessSync(source, constants.X_OK);
    const canonical = realpathSync(source);
    const stat = lstatSync(canonical, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw new Error('Bun runtime must be a bounded executable file');
    pinned = { canonical, identity: identity(stat) };
  } catch (error) { initialError = error; }
  let admission: Promise<CapturedExecBunRuntimeInput> | undefined;
  return (signal?: AbortSignal) => {
    admission ??= (async () => {
      if (initialError) throw initialError;
      if (!pinned) throw new Error('Bun runtime declaration is unavailable');
      const original = pinned;
      const filter = binding.readAccessFilter;
      if (!filter) throw new Error('Bun runtime requires original-owner read authorization');
      const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
      const check = async (current: AbortSignal | undefined = binding.signal): Promise<void> => {
        current = binding.signal && current ? AbortSignal.any([binding.signal, current]) : binding.signal ?? current;
        await assertContractInputAuthority(binding.authority, binding.root, current);
        if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('Bun runtime authority changed');
        for (const path of [source, original.canonical, TARGET]) {
          current?.throwIfAborted();
          if (!await executePolicyCheck(() => filter(path), current)) throw new Error('Bun runtime input is access-restricted');
        }
        await assertContractInputAuthority(binding.authority, binding.root, current);
        if (await realpath(source) !== original.canonical || identity(await lstat(original.canonical, { bigint: true })) !== original.identity)
          throw new Error('Bun runtime executable changed since trusted construction');
        await assertContractInputAuthority(binding.authority, binding.root, current);
        current?.throwIfAborted();
      };
      await check(combined);
      const data = await readFile(original.canonical);
      await check(combined);
      if (data.length > MAX_BYTES) throw new Error('Bun runtime exceeds bounded input size');
      const mode = Number((await lstat(original.canonical, { bigint: true })).mode & 0o777n);
      await check(combined);
      const temporary = await mkdtemp(join(tmpdir(), 'captured-bun-admission-'));
      try {
        const staged = join(temporary, 'bun');
        await writeFile(staged, data, { mode }); await chmod(staged, mode);
        await check(combined);
        // This proof sees no project mount or host configuration, and receives
        // no BUN_BE_BUN marker. A product executable is not an interpreter.
        if (!await probeCapturedBunRuntime(staged, combined)) throw new Error('Declared Bun runtime is not an available ordinary interpreter');
        await check(combined);
      } finally { await rm(temporary, { recursive: true, force: true }); }
      const token = Object.freeze({ kind: 'captured-exec-bun-runtime' as const });
      states.set(token, { binding, data, mode, check });
      registerContractInputReadAssertion(binding.authority, check);
      return token;
    })();
    return executePolicyCheck(() => admission!, signal);
  };
}

export async function projectCapturedExecBunRuntime(binding: CapturedExecAuthority, temporary: string, signal?: AbortSignal): Promise<{
  argv: string[]; check: (signal?: AbortSignal) => Promise<void>;
}> {
  if (!binding.bunRuntimeInput) return { argv: [], check: async () => {} };
  const state = states.get(binding.bunRuntimeInput);
  if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
    throw new Error('Bun runtime has no matching construction-owned admission');
  await state.check(signal);
  const staged = join(temporary, 'bun-runtime');
  await writeFile(staged, state.data, { mode: state.mode }); await chmod(staged, state.mode);
  await state.check(signal);
  return { check: () => state.check(signal), argv: ['--ro-bind', staged, TARGET] };
}
