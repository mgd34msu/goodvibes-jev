/**
 * Resolve this executable's update-artifact identity without activating updates.
 * Install-kind is a path heuristic, not authentication of a compiled artifact.
 * The CLI/host must separately opt in to the facade's update lifecycle.
 */
import type { DaemonUpdateArtifact } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { detectInstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { VERSION } from '../version.js';

export interface ResolveDaemonUpdateArtifactOptions {
  /** The executable to identify; defaults to process.execPath. */
  readonly execPath?: string;
  /** Injectable so tests can pin a fixture version. */
  readonly version?: string;
}

/** Returns no artifact for source or package-managed installs. */
export function resolveDaemonUpdateArtifact(
  options: ResolveDaemonUpdateArtifactOptions = {},
): DaemonUpdateArtifact | undefined {
  const execPath = options.execPath ?? process.execPath;
  if (detectInstallKind(execPath) !== 'binary') return undefined;
  return { version: options.version ?? VERSION, execPath };
}
