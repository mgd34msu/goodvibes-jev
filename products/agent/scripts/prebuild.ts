import { withWorkspaceLock } from './workspace-lock.ts';
import { syncProjectSurfaces } from './project-surfaces.ts';
import { patchBunCompileCompatibility } from './bun-compile-compat.ts';

/**
 * Prebuild script, syncs versioned package surfaces before compilation or
 * staging so release assets cannot race stale source files.
 */
try {
  withWorkspaceLock('sync project surfaces', () => {
    patchBunCompileCompatibility(process.cwd());
    syncProjectSurfaces(process.cwd());
  });
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
