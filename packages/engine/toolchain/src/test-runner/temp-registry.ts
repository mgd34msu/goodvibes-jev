/** Bounded, explicit cleanup inside the official runner's private child tree. */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const OWNED_TMP_ENV = 'GOODVIBES_TEST_OWNED_TMP_ROOT';

export function ownedTestTmpRoot(): string {
  const root = process.env[OWNED_TMP_ENV];
  if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1' || !root || !isAbsolute(root)) {
    throw new Error('Test temp allocation requires the official test runner (bun scripts/test.ts).');
  }
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Invalid owned test temp root');
  return realpathSync(root);
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Refuse links, including replacements introduced after registration. */
function safePath(root: string, path: string): boolean {
  if (!contained(root, path)) return false;
  let cursor = root;
  try {
    if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) return false;
    for (const part of relative(root, path).split(sep)) {
      cursor = resolve(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    }
    return true;
  } catch { return false; }
}

export interface TempDirRegistry {
  register(dir: string): string;
  unregister(dir: string): void;
  entries(): readonly string[];
  cleanup(): string[];
}

export function createTempDirRegistry(root?: string): TempDirRegistry {
  const registered = new Set<string>();
  let owned: string | undefined;
  let identity: { dev: number; ino: number } | undefined;
  const getRoot = (): string => {
    if (!owned) {
      const owner = ownedTestTmpRoot();
      const candidate = root ?? owner;
      if (resolve(candidate) !== owner && !contained(owner, resolve(candidate))) throw new Error('Registry root is outside the official owned test tree');
      if (lstatSync(candidate).isSymbolicLink()) throw new Error('Invalid owned test temp root');
      owned = realpathSync(candidate);
      if (owned !== owner && !contained(owner, owned)) { owned = undefined; throw new Error('Registry root escapes the official owned test tree'); }
      identity = lstatSync(owned);
    }
    const current = lstatSync(owned);
    if (current.dev !== identity!.dev || current.ino !== identity!.ino || current.isSymbolicLink()) throw new Error('Owned temp root was replaced');
    return owned;
  };
  return {
    register(dir) {
      const path = resolve(dir);
      if (!safePath(getRoot(), path)) throw new Error(`Refusing unowned test temp path: ${dir}`);
      registered.add(path);
      return dir;
    },
    unregister(dir) { registered.delete(resolve(dir)); },
    entries() { return [...registered]; },
    cleanup() {
      const removed: string[] = [];
      for (const dir of registered) {
        try {
          if (!safePath(getRoot(), dir)) continue;
          rmSync(dir, { recursive: true, force: true });
          if (!existsSync(dir)) { removed.push(dir); registered.delete(dir); }
        } catch { /* Retain unsuccessful entries for bounded retries and reporting. */ }
      }
      return removed;
    },
  };
}
const processRegistry = createTempDirRegistry();
export const registerTempDirForCleanup = (dir: string): string => processRegistry.register(dir);
export const unregisterTempDir = (dir: string): void => processRegistry.unregister(dir);
export const registeredTempDirs = (): readonly string[] => processRegistry.entries();
export const cleanupRegisteredTempDirs = (): string[] => processRegistry.cleanup();
export const DEFAULT_DRAIN_BACKOFF_MS: readonly number[] = [10, 25, 50, 100, 200, 400];
export interface DrainOptions {
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly registry?: TempDirRegistry;
}
export interface DrainResult { readonly removed: string[]; readonly survivors: string[]; readonly passes: number }
export async function drainTempDirsUntilSettled(options: DrainOptions = {}): Promise<DrainResult> {
  const delays = options.backoffMs ?? DEFAULT_DRAIN_BACKOFF_MS;
  if (delays.length > 32 || delays.some((ms) => !Number.isSafeInteger(ms) || ms < 0 || ms > 10_000)) throw new Error('Invalid bounded cleanup schedule');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const registry = options.registry ?? processRegistry;
  const tracked = new Set<string>();
  let passes = 0;
  const pass = (): void => {
    for (const path of registry.entries()) tracked.add(path);
    for (const path of tracked) {
      try { registry.register(path); } catch { /* Unsafe replacement remains a survivor. */ }
    }
    registry.cleanup();
    passes++;
  };
  pass();
  if (tracked.size === 0) return { removed: [], survivors: [], passes };
  // Observe the entire bounded schedule: a clean early check cannot prove a
  // delayed writer is finished. Parent teardown remains the final backstop.
  for (const delay of delays) { await sleep(delay); pass(); }
  await sleep(delays.at(-1) ?? 0);
  for (const path of registry.entries()) tracked.add(path);
  const present = (path: string): boolean => { try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; } };
  return { removed: [...tracked].filter((p) => !present(p)), survivors: [...tracked].filter(present), passes };
}
