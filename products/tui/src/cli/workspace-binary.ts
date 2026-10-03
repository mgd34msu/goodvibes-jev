import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

/** One shared path contract for the private launcher and its install verifier. */
export function workspaceBinaryCandidates(root: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): readonly string[] {
  const targetPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
  const suffix = platform === 'win32' ? '.exe' : '';
  return [join(root, 'dist', `goodvibes-${targetPlatform}-${arch}${suffix}`), join(root, 'dist', `goodvibes${suffix}`)];
}

/** Native build first, generic build second; directories and non-executable files are not binaries. */
export function resolveWorkspaceBinary(root: string): string | undefined {
  return workspaceBinaryCandidates(root).find(path => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch { return false; }
  });
}
