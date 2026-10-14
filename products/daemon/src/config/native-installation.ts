/**
 * Resolve this executable's update-artifact identity without activating updates.
 * Install-kind is a path heuristic, not authentication of a compiled artifact.
 * The CLI/host must separately opt in to the facade's update lifecycle.
 */
import { isAbsolute, join, dirname, resolve } from 'node:path';
import type { GoodVibesHomeOwnership } from '@goodvibes-jev/engine/sdk/platform/config';
import type { DaemonUpdateArtifact } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { captureUpdateFileIo, DAEMON_NATIVE_TARGETS, inspectDaemonNativeInstallation, realUpdateFileIo,
  resolveDaemonNativePayloads, resolveDaemonNativeTargets, retainDaemonNativeFiles } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
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

export interface ResolveInstalledDaemonUpdateArtifactOptions extends ResolveDaemonUpdateArtifactOptions {
  readonly platform?: string;
  readonly arch?: string;
  /** Construction seam only; the real caller uses this module's compiled location. */
  readonly bundled?: boolean;
  readonly signal?: AbortSignal;
}

/** Only a compiled daemon owning a complete native installation can self-manage. */
export function resolveInstalledDaemonUpdateArtifact(
  ownership: Pick<GoodVibesHomeOwnership, 'isOverridden'>,
  options: ResolveInstalledDaemonUpdateArtifactOptions = {},
): DaemonUpdateArtifact | undefined {
  const { execPath = process.execPath, version = VERSION, platform = process.platform, arch = process.arch,
    bundled = import.meta.url.includes('$bunfs'), signal } = options;
  if (ownership.isOverridden || !bundled || detectInstallKind(execPath) !== 'binary') return undefined;
  signal?.throwIfAborted();
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath) throw new Error('Native daemon executable must have an absolute normalized path');
  const targets = resolveDaemonNativeTargets(execPath, platform, arch);
  if (!targets) return undefined;
  const io = captureUpdateFileIo(realUpdateFileIo);
  // Transient slots are not a settled installation, including foreign-target slots.
  const paths = [...targets.map(target => target.path), ...DAEMON_NATIVE_TARGETS.flatMap(target =>
    (resolveDaemonNativePayloads('linux', target.slice('linux-'.length)) ?? []).map(payload => join(dirname(execPath), payload.relativePath)))];
  const assertIdle = () => {
    for (const path of paths) for (const suffix of ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
      if (io.exists(path + suffix)) throw new Error('Native daemon installation has an unfinished transaction');
    }
  };
  assertIdle();
  const assertInstallationCurrent = retainDaemonNativeFiles(targets, io);
  const receipt = inspectDaemonNativeInstallation(execPath, platform, arch, '', io, { integrity: false });
  if (!receipt || receipt.version !== version) throw new Error('Running daemon does not own the installed native version');
  const assertRetained = () => { signal?.throwIfAborted(); assertInstallationCurrent(); assertIdle(); };
  const assertCurrent = () => {
    assertRetained();
    inspectDaemonNativeInstallation(execPath, platform, arch, '', io);
    assertRetained();
  };
  let assertStarting = assertCurrent;
  try { assertCurrent(); }
  catch (error) {
    // A damaged current build can only reach the existing native crash-loop
    // recovery owner; normal startup still has to pass assertCurrent.
    assertRetained();
    if (!inspectDaemonNativeInstallation(execPath, platform, arch, '.previous', io)) throw error;
    assertStarting = () => {
      assertRetained();
      inspectDaemonNativeInstallation(execPath, platform, arch, '.previous', io);
      assertRetained();
    };
  }
  assertStarting();
  return Object.freeze({ version, execPath, assertStarting, assertCurrent });
}
