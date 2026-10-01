import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';
/**
 * `/update`, a real self-update path for binary installs. The
 * download-verify-swap mechanics are the SDK's canonical update policy module
 * (platform/runtime/self-update), the same mechanism the TUI's `/update` and
 * the daemon's hourly loop follow: one update mechanism everywhere. This file
 * owns only the agent's /update UX: install-kind gating, this repo's release
 * asset layout, and the printed report.
 *
 * Subcommands:
 *   /update [check]  , resolve the latest release tag and report whether this
 *                       build is already current.
 *   /update apply    , for a binary install (a directly-downloaded release
 *                       binary), download + verify + atomically swap the agent
 *                       binary, and refresh the sqlite-vec native addon in
 *                       lockstep so the vector index never goes stale beside a
 *                       new binary. Every swap parks the outgoing file at
 *                       `<path>.previous`, so the replaced version is always
 *                       kept. For any other install kind, prints the exact
 *                       command to run instead, it never attempts a swap it
 *                       can't do safely.
 *   /update rollback , exchange each installed file with its kept `.previous`
 *                       counterpart: one command back to the version that ran
 *                       before the last update (and, being an exchange, one
 *                       more command forward again).
 *
 * The agent ships ONE binary and no daemon binary, and its addon travels as a
 * tar.gz ARCHIVE asset (see release-artifacts.ts) rather than a bare file,
 * so the addon bytes are downloaded and checksum-verified as the archive,
 * extracted in memory, and only then swapped with the same keep-previous
 * mechanics as the binary. Verification order is strict: the addon archive is
 * fully verified and extracted BEFORE the binary swap begins, so a corrupted
 * addon download can never leave a new binary beside a stale (or half-written)
 * addon.
 *
 * The browser driver rides the same rules, with one difference that matters: it
 * is a DIRECTORY (`playwright-core/`), not a file, so it cannot go through
 * swapFileAtomically. It is extracted into `playwright-core.incoming`, and only
 * a complete extraction is moved into place, with the outgoing directory parked
 * at `playwright-core.previous`. Refreshing it here is not optional polish, an
 * in-place binary swap that left the old driver behind would pair a new build
 * with a driver version it was never tested against, and a swap that left none
 * behind would silently remove browser control from a working install.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyVerifiedUpdate,
  realUpdateFileIo,
  rollbackKeptPrevious,
  sha256,
  swapFileAtomically,
  verifyChecksum,
  type UpdateFileIo,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import type { CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import {
  BROWSER_DRIVER_ARCHIVE_NAME,
  BROWSER_DRIVER_DIR_NAME,
  BROWSER_DRIVER_REQUIRED_ENTRIES,
  CHECKSUM_MANIFEST_NAME,
  extractTarGzEntry,
  parseChecksumFile,
  resolveAgentBinaryAssetName,
  resolveSqliteVecArchive,
} from '../../runtime/release-artifacts.ts';
import { extractTarGzTree } from '../../runtime/tar-archive.ts';
import {
  compareVersions,
  detectInstallKind,
  fallbackUpdateCommand,
  normalizeVersion,
  resolveLatestReleaseTag,
  type InstallKind,
  type UpdateFetchLike,
} from '../../runtime/update-check.ts';

const REPO_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-agent/releases/latest';

function releaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/mgd34msu/goodvibes-agent/releases/download/${tag}`;
}

/**
 * Suffix under which every swap keeps the file it replaced, re-exported from
 * the SDK's canonical update policy module so rollback and swap share one
 * definition everywhere.
 */
export { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

async function downloadBytes(fetchImpl: UpdateFetchLike, url: string): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Directory-level filesystem seam, for the one installed artifact that is a
 * directory rather than a file. Injected for the same reason UpdateFileIo is:
 * a test must be able to observe the swap without extracting 14MB of driver
 * onto a real disk.
 */
export interface UpdateDirectoryIo {
  exists(path: string): boolean;
  removeTree(path: string): void;
  rename(from: string, to: string): void;
  /** Writes an archive's contents under `destination`, creating it. */
  extractArchive(archive: Buffer, destination: string): void;
}

export const realUpdateDirectoryIo: UpdateDirectoryIo = {
  exists: (path) => existsSync(path),
  removeTree: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  extractArchive: (archive, destination) => {
    extractTarGzTree(archive, destination, { stripComponents: 1 });
  },
};

/**
 * Replaces the driver directory beside the binary, keeping the outgoing one.
 *
 * Order is the whole safety argument: extract to a scratch directory first, and
 * only once that has completed do the two renames that make it live. A failure
 * anywhere before the final rename leaves the existing driver untouched.
 */
export function swapDirectory(
  targetPath: string,
  archive: Buffer,
  io: UpdateDirectoryIo,
): void {
  const incoming = `${targetPath}.incoming`;
  const kept = `${targetPath}${PREVIOUS_FILE_SUFFIX}`;
  io.removeTree(incoming);
  io.extractArchive(archive, incoming);
  if (io.exists(targetPath)) {
    io.removeTree(kept);
    io.rename(targetPath, kept);
  }
  io.rename(incoming, targetPath);
}

export interface CheckForUpdateResult {
  readonly latestTag: string;
  readonly isCurrent: boolean;
}

export async function checkForUpdate(fetchImpl: UpdateFetchLike, currentVersion: string): Promise<CheckForUpdateResult> {
  const latestTag = await resolveLatestReleaseTag(fetchImpl, REPO_RELEASES_LATEST_URL);
  const isCurrent = compareVersions(currentVersion, latestTag) >= 0;
  return { latestTag, isCurrent };
}

export interface ApplyUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly print: (line: string) => void;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe swaps in memory. */
  readonly io?: UpdateFileIo;
  /** Injectable directory seam, for the browser driver (a directory, not a file). */
  readonly directoryIo?: UpdateDirectoryIo;
}

/**
 * The real self-update path, delegating the download-verify-swap mechanics to
 * the SDK's canonical update policy module. For a binary install: resolve the
 * latest tag, compare to the running version, and if newer, verify and stage
 * the addon archive first (bytes in memory, no writes), run the binary
 * download-verify-swap, then swap the extracted addon file, each swap keeps
 * the outgoing file at `<path>.previous`. For any other install kind, never
 * attempts a swap, it prints the exact command for that install method
 * instead.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<void> {
  const installKind: InstallKind = detectInstallKind(options.execPath);
  if (installKind !== 'binary') {
    options.print(
      [
        `This install is not a self-updatable binary install (detected: ${installKind === 'bun-global-package' ? 'bun/npm package install' : 'running from source'}).`,
        `Update with: ${fallbackUpdateCommand(installKind)}`,
      ].join('\n'),
    );
    return;
  }

  const latestTag = await resolveLatestReleaseTag(options.fetchImpl, REPO_RELEASES_LATEST_URL);
  if (compareVersions(options.currentVersion, latestTag) >= 0) {
    options.print(`Already current: running v${normalizeVersion(options.currentVersion)}, latest release is ${latestTag}.`);
    return;
  }

  const binaryAsset = resolveAgentBinaryAssetName(options.platform, options.arch);
  if (!binaryAsset) {
    options.print(`No prebuilt binaries are published for ${options.platform}-${options.arch}; cannot self-update.`);
    return;
  }

  options.print(`Update available: ${latestTag} (running v${normalizeVersion(options.currentVersion)}). Downloading and verifying...`);

  const baseUrl = releaseDownloadBaseUrl(latestTag);
  const io = options.io ?? realUpdateFileIo;
  const appBinaryPath = options.execPath;

  // The sqlite-vec native addon travels with the binary as a tar.gz archive
  // asset: refresh it in the same update so /update never leaves a new binary
  // beside a stale addon. The manifest entry decides whether the target
  // release ships it, an entry that IS present makes the download, checksum,
  // and extraction mandatory (any failure is fatal, verified before the
  // binary swap begins), while an absent entry means the target predates the
  // addon archives and is skipped rather than blocking an otherwise-valid
  // binary update.
  const manifestBytes = await downloadBytes(options.fetchImpl, `${baseUrl}/${CHECKSUM_MANIFEST_NAME}`);
  const checksums = parseChecksumFile(manifestBytes.toString('utf-8'));
  const addon = resolveSqliteVecArchive(options.platform, options.arch);
  const addonIncluded = addon !== null && checksums.get(addon.assetName) !== undefined;
  let addonFileBytes: Buffer | null = null;
  let addonTargetPath: string | null = null;
  if (addon && addonIncluded) {
    const archiveBytes = await downloadBytes(options.fetchImpl, `${baseUrl}/${addon.assetName}`);
    verifyChecksum(addon.assetName, sha256(archiveBytes), checksums.get(addon.assetName));
    addonFileBytes = extractTarGzEntry(archiveBytes, addon.entryPath);
    if (addonFileBytes === null) {
      throw new Error(`addon archive ${addon.assetName} verified but holds no ${addon.entryPath}, refusing a partial update`);
    }
    addonTargetPath = join(dirname(appBinaryPath), 'lib', addon.dirName, addon.fileName);
  }

  // The browser driver travels beside the binary as its own archive. Same
  // contract as the addon: an entry in the manifest makes download, checksum,
  // and structural verification mandatory before anything is swapped; no entry
  // means the target release predates shipping a driver, which is skipped
  // rather than blocking an otherwise-valid binary update.
  const driverIncluded = checksums.get(BROWSER_DRIVER_ARCHIVE_NAME) !== undefined;
  let driverArchiveBytes: Buffer | null = null;
  let driverTargetPath: string | null = null;
  if (driverIncluded) {
    driverArchiveBytes = await downloadBytes(options.fetchImpl, `${baseUrl}/${BROWSER_DRIVER_ARCHIVE_NAME}`);
    verifyChecksum(BROWSER_DRIVER_ARCHIVE_NAME, sha256(driverArchiveBytes), checksums.get(BROWSER_DRIVER_ARCHIVE_NAME));
    for (const required of BROWSER_DRIVER_REQUIRED_ENTRIES) {
      if (extractTarGzEntry(driverArchiveBytes, required) === null) {
        throw new Error(`browser driver archive ${BROWSER_DRIVER_ARCHIVE_NAME} verified but holds no ${required}, refusing a partial update`);
      }
    }
    driverTargetPath = join(dirname(appBinaryPath), BROWSER_DRIVER_DIR_NAME);
  }

  // One mechanism everywhere: downloads + verifies the binary against the
  // same manifest, then swaps it atomically with the outgoing file kept at
  // `<path>.previous`. The addon bytes above are already verified, so the
  // addon swap after this cannot fail on bad data.
  await applyVerifiedUpdate({
    fetchImpl: options.fetchImpl,
    downloadBaseUrl: baseUrl,
    targets: [{ label: 'agent binary', path: appBinaryPath, assetName: binaryAsset, executable: true }],
    io,
    platform: options.platform,
  });
  if (addonFileBytes !== null && addonTargetPath !== null) {
    swapFileAtomically(addonTargetPath, addonFileBytes, { executable: false, io, platform: options.platform });
  }
  if (driverArchiveBytes !== null && driverTargetPath !== null) {
    swapDirectory(driverTargetPath, driverArchiveBytes, options.directoryIo ?? realUpdateDirectoryIo);
  }

  options.print(
    [
      `Updated to ${latestTag}.`,
      `  agent binary:  ${appBinaryPath}`,
      ...(addonTargetPath
        ? [`  vector addon:  ${addonTargetPath}`]
        : [`  vector addon:  the ${latestTag} release ships no ${addon?.assetName ?? 'addon archive'} for this platform, left untouched`]),
      ...(driverTargetPath
        ? [`  browser driver: ${driverTargetPath}`]
        : [`  browser driver: the ${latestTag} release ships no ${BROWSER_DRIVER_ARCHIVE_NAME}, left untouched; the browser tool installs a driver for itself on first use`]),
      '',
      'Restart goodvibes-agent to run the new version.',
    ].join('\n'),
  );
}

export interface RollbackUpdateOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly print: (line: string) => void;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe renames in memory. */
  readonly io?: UpdateFileIo;
  /** Injectable directory seam, for the browser driver (a directory, not a file). */
  readonly directoryIo?: UpdateDirectoryIo;
}

/**
 * Exchanges a directory with its kept `.previous` counterpart, via a scratch
 * name so neither side is ever gone. Returns false when nothing is kept.
 */
export function rollbackDirectory(targetPath: string, io: UpdateDirectoryIo): boolean {
  const kept = `${targetPath}${PREVIOUS_FILE_SUFFIX}`;
  if (!io.exists(kept)) return false;
  const scratch = `${targetPath}.rolling`;
  io.removeTree(scratch);
  if (io.exists(targetPath)) io.rename(targetPath, scratch);
  io.rename(kept, targetPath);
  if (io.exists(scratch)) io.rename(scratch, kept);
  return true;
}

/**
 * One-command rollback to the version that ran before the last update,
 * delegating the exchange mechanics to the SDK's rollbackKeptPrevious (the
 * same module the swap uses): every installed file (agent binary, vector
 * addon) that has a kept `.previous` counterpart is EXCHANGED with it, the
 * previous version becomes live, and the version being rolled back is itself
 * kept at `.previous`, so a second `/update rollback` rolls forward again.
 * Files without a kept counterpart are reported and left untouched; nothing
 * is downloaded.
 */
export function rollbackUpdate(options: RollbackUpdateOptions): void {
  const installKind: InstallKind = detectInstallKind(options.execPath);
  if (installKind !== 'binary') {
    options.print(
      [
        `This install is not a self-updatable binary install (detected: ${installKind === 'bun-global-package' ? 'bun/npm package install' : 'running from source'}), so there is no kept previous binary to roll back to.`,
        `Install a specific version with your package manager instead, e.g.: ${fallbackUpdateCommand(installKind)}`,
      ].join('\n'),
    );
    return;
  }

  const io = options.io ?? realUpdateFileIo;
  const addon = resolveSqliteVecArchive(options.platform, options.arch);
  const targets = [
    { label: 'agent binary', path: options.execPath },
    ...(addon ? [{ label: 'vector addon', path: join(dirname(options.execPath), 'lib', addon.dirName, addon.fileName) }] : []),
  ];

  const result = rollbackKeptPrevious(targets, io);
  // The driver is a directory, so it rolls back through its own exchange
  // rather than rollbackKeptPrevious. It travels with the binary in both
  // directions: rolling a binary back onto a newer driver is the same mismatch
  // the forward path exists to prevent.
  const driverPath = join(dirname(options.execPath), BROWSER_DRIVER_DIR_NAME);
  const driverRolledBack = rollbackDirectory(driverPath, options.directoryIo ?? realUpdateDirectoryIo);
  if (result.restored.length === 0 && !driverRolledBack) {
    options.print(
      `No previous version is kept beside this install (nothing at ${options.execPath}${PREVIOUS_FILE_SUFFIX}). ` +
      'The previous version is kept from the next update onward.',
    );
    return;
  }

  options.print(
    [
      'Rolled back to the previously installed version.',
      ...result.restored.map((target) => `  ${target.label}: ${target.path} (the replaced version is kept at ${target.path}${PREVIOUS_FILE_SUFFIX})`),
      ...(driverRolledBack ? [`  browser driver: ${driverPath} (the replaced version is kept at ${driverPath}${PREVIOUS_FILE_SUFFIX})`] : []),
      '',
      'Restart goodvibes-agent to run the restored version.',
    ].join('\n'),
  );
}

export function registerUpdateCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'update',
    aliases: ['upgrade'],
    description: 'Check for a newer GoodVibes Agent release and, for binary installs, download/verify/apply it or roll back to the kept previous version',
    usage: '[check|apply|rollback]',
    async handler(args, ctx) {
      if (IS_WORKSPACE_DISTRIBUTION) { ctx.print(WORKSPACE_UPDATE_GUIDANCE); return; }
      const sub = args[0] ?? 'check';

      if (sub === 'check') {
        try {
          const result = await checkForUpdate(fetch as UpdateFetchLike, VERSION);
          ctx.print(
            result.isCurrent
              ? `Already current: running v${normalizeVersion(VERSION)} (latest release is ${result.latestTag}).`
              : `Update available: ${result.latestTag} (running v${normalizeVersion(VERSION)}). Run /update apply to install it.`,
          );
        } catch (error) {
          ctx.print(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'apply') {
        try {
          await applyUpdate({
            fetchImpl: fetch as UpdateFetchLike,
            execPath: process.execPath,
            platform: process.platform,
            arch: process.arch,
            currentVersion: VERSION,
            print: ctx.print,
          });
        } catch (error) {
          ctx.print(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'rollback') {
        try {
          rollbackUpdate({
            execPath: process.execPath,
            platform: process.platform,
            arch: process.arch,
            print: ctx.print,
          });
        } catch (error) {
          ctx.print(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      ctx.print('Usage: /update [check|apply|rollback]');
    },
  });
}
