/**
 * Pure logic for `/update` and the launch-time self-update: version
 * comparison, the latest-release-tag redirect lookup, and honest install-kind
 * detection.
 *
 * Version comparison and the release-tag lookup are re-exported from the
 * SDK's canonical update policy module (platform/runtime/self-update), one
 * mechanism everywhere, the same module the TUI and the daemon's hourly loop
 * consume. Install-kind detection comes from the SDK too
 * (platform/runtime/install-kind): the same three-way answer, compiled
 * binary, package-managed vendored binary, or a source run, everywhere. What
 * stays here is this product's own answer to "then what should I run
 * instead", which names this package.
 *
 * The self-update download/verify/swap orchestration that USES these lives in
 * src/input/commands/update-runtime.ts; this module only decides "is there a
 * newer version" and "can this install be swapped in place".
 */
export {
  compareVersions,
  normalizeVersion,
  parseReleaseTagFromLocation,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

export type { InstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
export { detectInstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

import type { InstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

/**
 * The exact command to tell the user to run instead of an in-place swap.
 *
 * The Agent's supported managed install path is the Bun global package (see
 * README), and a source checkout is a developer running this repo, both are
 * moved by the package manager, so both point there rather than at the suite
 * installer.
 */
export function fallbackUpdateCommand(kind: Exclude<InstallKind, 'binary'>): string {
  void kind;
  return 'bun add -g @pellux/goodvibes-agent';
}
