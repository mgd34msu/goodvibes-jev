/** Admit the actual shipped executable without choosing another binary from PATH or environment. */
import { resolveInstalledDaemonUpdateArtifact, type ResolveInstalledDaemonUpdateArtifactOptions } from '../daemon/lifecycle.js';

export interface ShippedServiceExecutable {
  readonly binaryPath: string;
  readonly assertCurrent: () => void;
}

/** Lazy one-shot admission. A source invocation cannot activate an adjacent native installation. */
export function resolveShippedServiceExecutable(
  options: ResolveInstalledDaemonUpdateArtifactOptions = {},
): ShippedServiceExecutable | undefined {
  // Service home selection does not change the executable's installation.
  // The existing dispatcher separately checks the selected unit definition.
  const artifact = resolveInstalledDaemonUpdateArtifact({ isOverridden: false }, options);
  if (!artifact) return undefined;
  const binaryPath = artifact.execPath;
  if (!binaryPath) throw new Error('Native service executable path is unavailable');
  const current = artifact.assertCurrent;
  if (!current) throw new Error('Native service executable admission is unavailable');
  // Recovery-only admission must never start a service with damaged current bytes.
  current();
  return Object.freeze({ binaryPath, assertCurrent: current });
}
