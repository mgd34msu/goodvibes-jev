import { withWorkspaceLock } from './workspace-lock.ts';
import { syncProjectSurfaces } from './project-surfaces.ts';

/**
 * Prebuild script, syncs versioned package surfaces before compilation or
 * staging so release assets cannot race stale source files.
 */
try {
  withWorkspaceLock('sync project surfaces', () => {
    syncProjectSurfaces(process.cwd());
  });
} catch (error) {
  console.error('prebuild: failed:', error);
  process.exit(1);
}
