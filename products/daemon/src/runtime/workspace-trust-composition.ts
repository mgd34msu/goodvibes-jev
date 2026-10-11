/** One live trust authority for each physical workspace owned by this daemon. */
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { WorkspaceTrustManager } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';

const trustByHost = new WeakMap<WorkspaceTrustManager, Map<string, WorkspaceTrustManager>>();
function workspaceTrustKey(workspaceRoot: string): string {
  let parent = resolve(workspaceRoot);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(parent), ...suffix); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(basename(parent)); parent = next;
    }
  }
}

export function createDaemonWorkspaceTrustResolver(owner: {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly workspaceTrustManager: WorkspaceTrustManager;
}): (workspaceRoot: string) => WorkspaceTrustManager {
  let cache = trustByHost.get(owner.workspaceTrustManager);
  if (!cache) {
    cache = new Map([[workspaceTrustKey(owner.workingDirectory), owner.workspaceTrustManager]]);
    trustByHost.set(owner.workspaceTrustManager, cache);
  }
  const trustByWorkspace = cache;
  return (workspaceRoot) => {
    const key = workspaceTrustKey(workspaceRoot);
    let trust = trustByWorkspace.get(key);
    if (!trust) {
      trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: key, homeDirectory: owner.homeDirectory }), surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
      trustByWorkspace.set(key, trust);
    }
    return trust;
  };
}
