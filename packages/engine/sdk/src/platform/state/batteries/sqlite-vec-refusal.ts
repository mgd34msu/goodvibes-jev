/**
 * `engine.state.sqlite-vec-refusal`: whether an error from loading the
 * sqlite-vec extension says the platform's SQLite refuses to load extensions
 * at all, as opposed to the extension file being missing, unreadable or
 * broken. Read by Jev in place of sqlite-vec-loader.ts isExtensionLoadingRefusal,
 * a regex over the message (not authorized, omit...load...extension,
 * extension loading is disabled, does not support dynamic extension loading)
 * that misread any build wording it did not list. No error code carries this.
 *
 * What code does with it (sqlite-vec-loader.ts loadSqliteVecExtension): a yes
 * the band allows acting on throws SqliteVecPlatformUnsupportedError, which
 * the stores report quietly as platformLimitReason; anything else rethrows
 * the original error, which the stores report as `error`, the field release
 * smokes and fault monitors act on.
 *
 * Band: medium stakes. A wrong yes hides a packaging defect from the release
 * smoke; a wrong no raises a false fault. Either way search degrades to
 * literal matching, so nothing is lost beyond the report.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Longest error message one request carries; the cause is in its opening. */
const MAX_MESSAGE_CHARS = 2_000;

export type SqliteVecLoadFailureView = {
  /** The load error's message. */
  readonly message: string;
  /** process.platform of the running process. */
  readonly platform: string;
  /** Whether the run is a compiled single-file binary, which loads the extension co-located with it. */
  readonly bundled: boolean;
};

export function sqliteVecLoadFailureView(message: string, platform: string, bundled: boolean): SqliteVecLoadFailureView {
  return { message: message.slice(0, MAX_MESSAGE_CHARS), platform, bundled };
}

export const sqliteVecRefusal = defineBattery({
  name: 'engine.state.sqlite-vec-refusal',
  version: 1,
  description: 'Whether an error from loading the sqlite-vec SQLite extension says the platform\'s SQLite refuses extension loading altogether, rather than the extension file being missing, unreadable or broken.',
  accuracyFloor: 0.9,
  items: {
    platform_refuses: yesNo(
      'A program tried to load the sqlite-vec extension into SQLite and got the error in `message`. `platform` is the operating system and `bundled` says whether the program is a compiled single-file binary. Does this error say that this SQLite refuses to load extensions at all (extension loading is disabled, not authorized, or compiled out of this SQLite build), as opposed to a problem with the extension file itself?',
      STAKES_BANDS.medium.yesNo,
      {
        true: 'The SQLite library itself will not load any extension: loading is disabled, not authorized, or not supported by this build.',
        false: 'The problem is the extension file or package: missing, not found, unreadable, the wrong architecture, a missing symbol, a corrupt file, or some other failure.',
      },
    ),
  },
  fixtures: [
    {
      name: 'macOS system SQLite without dynamic loading',
      state: sqliteVecLoadFailureView('This build of sqlite3 does not support dynamic extension loading', 'darwin', true),
      expect: { platform_refuses: 'yes' },
    },
    {
      name: 'not authorized',
      state: sqliteVecLoadFailureView('not authorized', 'darwin', true),
      expect: { platform_refuses: 'yes' },
    },
    {
      name: 'extension loading disabled on the connection',
      state: sqliteVecLoadFailureView('SQLITE_ERROR: extension loading is disabled for this connection', 'linux', false),
      expect: { platform_refuses: 'yes' },
    },
    {
      name: 'load_extension compiled out',
      state: sqliteVecLoadFailureView('sqlite3_load_extension is unavailable: this SQLite was compiled with SQLITE_OMIT_LOAD_EXTENSION', 'linux', true),
      expect: { platform_refuses: 'yes' },
    },
    {
      name: 'extension file missing next to the binary',
      state: sqliteVecLoadFailureView('dlopen(/Applications/GoodVibes/lib/sqlite-vec-darwin-arm64/vec0.dylib, 0x0002): tried: \'/Applications/GoodVibes/lib/sqlite-vec-darwin-arm64/vec0.dylib\' (no such file)', 'darwin', true),
      expect: { platform_refuses: 'no' },
    },
    {
      name: 'shared object not found',
      state: sqliteVecLoadFailureView('/opt/goodvibes/lib/sqlite-vec-linux-x64/vec0.so: cannot open shared object file: No such file or directory', 'linux', true),
      expect: { platform_refuses: 'no' },
    },
    {
      name: 'package not installed',
      state: sqliteVecLoadFailureView("Cannot find module 'sqlite-vec' from '/home/dev/project/packages/engine/sdk/src/platform/state/sqlite-vec-loader.ts'", 'linux', false),
      expect: { platform_refuses: 'no' },
    },
    {
      name: 'wrong architecture',
      state: sqliteVecLoadFailureView("dlopen(/usr/local/lib/goodvibes/lib/sqlite-vec-darwin-arm64/vec0.dylib, 0x0002): tried: '/usr/local/lib/goodvibes/lib/sqlite-vec-darwin-arm64/vec0.dylib' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))", 'darwin', true),
      expect: { platform_refuses: 'no' },
    },
    {
      name: 'unreadable file',
      state: sqliteVecLoadFailureView('/srv/goodvibes/lib/sqlite-vec-linux-x64/vec0.so: cannot open shared object file: Permission denied', 'linux', true),
      expect: { platform_refuses: 'no' },
    },
    {
      name: 'missing entry point',
      state: sqliteVecLoadFailureView('The specified procedure could not be found: sqlite3_vec_init in C:\\Program Files\\GoodVibes\\lib\\sqlite-vec-windows-x64\\vec0.dll', 'win32', true),
      expect: { platform_refuses: 'no' },
    },
  ],
});
