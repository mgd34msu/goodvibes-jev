/**
 * Names and shapes of this repo's release assets, exactly as the Release
 * workflow publishes them (.github/workflows/release.yml):
 *
 *   - compiled binaries `goodvibes-agent-<os>-<arch>` for linux/macos ×
 *     x64/arm64 (the release tag maps darwin → "macos");
 *   - per-platform sqlite-vec native addon ARCHIVES named
 *     `sqlite-vec-<platform>-<arch>.tar.gz` (Node-style platform tag), each
 *     carrying the exact layout the runtime resolves relative to the binary,
 *     `lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>`;
 *   - one platform-independent `browser-driver.tar.gz` carrying the Playwright
 *     driver package as `playwright-core/…`, which is the first place
 *     driverSearchDirectories looks (`<execDir>/playwright-core`). The driver
 *     is plain JavaScript, so one archive serves every platform;
 *   - one `SHA256SUMS.txt` manifest covering every asset above.
 *
 * The checksum manifest name and parser are the SDK's canonical ones
 * (platform/runtime/self-update) so the agent verifies with the same
 * mechanism every other surface uses. Asset NAMING stays local because it
 * encodes THIS repo's release layout, the SDK's resolveArtifactNames names
 * the TUI's `goodvibes` binary and the daemon repo's `goodvibes-daemon-*`
 * assets, neither of which this repo ships.
 */
export { CHECKSUM_MANIFEST_NAME, parseChecksumFile } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
export { extractTarGzEntry } from './tar-archive.ts';

const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);

/**
 * Release asset name of the compiled agent binary for a platform/arch, or
 * null when no prebuilt binary is published for it (the release ships no
 * Windows binary asset).
 */
export function resolveAgentBinaryAssetName(platform: string, arch: string): string | null {
  if (!SUPPORTED_ARCHES.has(arch)) return null;
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : null;
  if (!os) return null;
  return `goodvibes-agent-${os}-${arch}`;
}

export interface SqliteVecArchiveAsset {
  /** Release asset filename, e.g. `sqlite-vec-linux-x64.tar.gz`. */
  readonly assetName: string;
  /** Directory name the loader resolves, e.g. `sqlite-vec-linux-x64`. */
  readonly dirName: string;
  /** File the loader opens inside that directory, e.g. `vec0.so`. */
  readonly fileName: string;
  /** The addon file's path inside the archive (and relative to the binary): `lib/<dirName>/<fileName>`. */
  readonly entryPath: string;
}

/**
 * Names the sqlite-vec addon ARCHIVE for a platform/arch. Unlike the binary
 * (whose release name maps darwin to "macos"), the archive keeps the
 * Node-style platform tag because that is exactly what the extension loader
 * resolves at `<execDir>/lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>`.
 */
export function resolveSqliteVecArchive(platform: string, arch: string): SqliteVecArchiveAsset | null {
  if (!SUPPORTED_ARCHES.has(arch)) return null;
  const suffix = platform === 'linux' ? 'so' : platform === 'darwin' ? 'dylib' : null;
  if (!suffix) return null;
  const dirName = `sqlite-vec-${platform}-${arch}`;
  const fileName = `vec0.${suffix}`;
  return {
    assetName: `${dirName}.tar.gz`,
    dirName,
    fileName,
    entryPath: `lib/${dirName}/${fileName}`,
  };
}

/**
 * The Playwright driver ARCHIVE. One asset for every platform: the driver is
 * plain JavaScript, and the browser binaries it drives are downloaded
 * separately into the managed cache. Extracting it beside the executable
 * produces `<execDir>/playwright-core/…`, the first entry in
 * driverSearchDirectories (see @goodvibes-jev/engine/sdk/platform/browser, and
 * runtime/agent-browser.ts for this surface's binding of it).
 */
export const BROWSER_DRIVER_ARCHIVE_NAME = 'browser-driver.tar.gz';

/** Directory name the driver resolves under, beside the executable. */
export const BROWSER_DRIVER_DIR_NAME = 'playwright-core';

/**
 * A file the archive must contain for the extraction to be considered whole.
 * `cli.js` is what the browser install step executes, so an archive without it
 * is not a usable driver no matter what else extracted.
 */
export const BROWSER_DRIVER_REQUIRED_ENTRIES: readonly string[] = [
  `${BROWSER_DRIVER_DIR_NAME}/package.json`,
  `${BROWSER_DRIVER_DIR_NAME}/index.js`,
  `${BROWSER_DRIVER_DIR_NAME}/cli.js`,
];
