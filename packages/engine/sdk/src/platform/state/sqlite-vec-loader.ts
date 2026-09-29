/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { sqliteVecLoadFailureView, sqliteVecRefusal } from './batteries/sqlite-vec-refusal.js';

const SQLITE_VEC_REFUSAL_SITE = 'state.sqlite-vec-loader';

/**
 * `sqlite-vec` is an optionalDependency, resolved through `createRequire` at
 * the one call that needs it rather than imported statically, the same technique,
 * and for the same reason, as the `bun:sqlite` resolution in
 * knowledge/browser-history/readers.ts: a static import puts the specifier on
 * the module graph, and a graph that cannot link is a process that dies at
 * module init with no handler running. See utils/optional-dependency.ts.
 *
 * In a compiled binary this is never called: `resolveSqliteVecPath()` returns
 * the co-located extension and `db.loadExtension` takes that path. It is the
 * development and unbundled-runtime path that needs the package.
 */
function requireSqliteVecLoad(): (db: Database) => void {
  const mod = createRequire(import.meta.url)('sqlite-vec') as { load: (db: Database) => void };
  return mod.load;
}

/**
 * Resolves the path to the sqlite-vec native extension.
 *
 * When running inside a Bun bundled executable (import.meta.url path contains
 * "$bunfs"), the npm package's import.meta.resolve() cannot find the extension
 * because the virtual filesystem does not contain node_modules. In that case,
 * the extension must be co-located with the binary under
 * `<execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>`.
 *
 * In development (bun run / node), the package's own getLoadablePath() is used
 * via the re-exported `load()` function.
 *
 * Shared by memory-vector-store.ts (MemoryStore's vector index) and
 * code-index-store.ts (the repo source-tree code index; see CHANGELOG 0.38.0) so both
 * indexes load the exact same native extension the exact same way.
 */
/** Whether this is a Bun compiled binary: Bun's virtual bundle filesystem is marked `$bunfs` in module URLs. */
function isBundledRun(): boolean {
  return import.meta.url.includes('$bunfs');
}

export function resolveSqliteVecPath(): string {
  if (isBundledRun()) {
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch;
    const suffix = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
    return join(dirname(process.execPath), 'lib', `sqlite-vec-${os}-${arch}`, `vec0.${suffix}`);
  }
  // In dev mode, delegate to sqlite-vec's own resolver.
  return '';
}

/**
 * Thrown when the RUNTIME PLATFORM cannot load SQLite extensions at all,
 * most commonly a macOS-compiled binary, where bun:sqlite links Apple's
 * system SQLite, which ships with extension loading disabled. This is a
 * permanent capability limit of the platform, not a defect in the build:
 * callers should degrade to their documented no-vector mode with the
 * `reason` surfaced, rather than reporting an error. A missing extension
 * FILE (a genuine packaging defect) deliberately does NOT map to this class.
 */
export class SqliteVecPlatformUnsupportedError extends Error {
  readonly platformLimit = true;

  constructor(cause: string) {
    super(
      "this platform's SQLite does not allow loading extensions"
      + ' (macOS system SQLite); the semantic vector index is unavailable'
      + ` and memory search uses literal matching. Underlying refusal: ${cause}`,
    );
    this.name = 'SqliteVecPlatformUnsupportedError';
  }
}

/**
 * Whether a load failure is the platform refusing extension loading, read by
 * Jev (`engine.state.sqlite-vec-refusal`, batteries/sqlite-vec-refusal.ts):
 * true only on a yes the band allows acting on. The action is recorded.
 */
async function readsAsPlatformRefusal(message: string): Promise<boolean> {
  const run = await sqliteVecRefusal.run(
    judgmentPort(SQLITE_VEC_REFUSAL_SITE),
    sqliteVecLoadFailureView(message, process.platform, isBundledRun()),
    { site: SQLITE_VEC_REFUSAL_SITE },
  );
  const refuses = run.readings.platform_refuses;
  const platformLimit = refuses.verdict === 'yes' && refuses.outcome === 'act';
  run.recordAction(platformLimit ? 'platform-limit' : 'rethrown');
  return platformLimit;
}

/**
 * Loads the sqlite-vec extension into a Bun SQLite database.
 * Handles both bundled-binary and development execution contexts.
 *
 * Throws SqliteVecPlatformUnsupportedError when the platform itself refuses
 * extension loading (see the class doc); rethrows everything else untouched.
 * The refusal is read by Jev only when loading fails.
 */
export async function loadSqliteVecExtension(db: Database): Promise<void> {
  const bundledPath = resolveSqliteVecPath();
  try {
    if (bundledPath) {
      db.loadExtension(bundledPath);
    } else {
      requireSqliteVecLoad()(db);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (await readsAsPlatformRefusal(message)) {
      throw new SqliteVecPlatformUnsupportedError(message);
    }
    throw err;
  }
}
