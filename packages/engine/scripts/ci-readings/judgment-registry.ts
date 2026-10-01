import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Editorial decisions available for optional stored readings and calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/scripts/ci-readings/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Whether a package README documents the package, and whether its wording is stale (package metadata check).
import { packageReadme } from './package-readme.ts';
registry.register(packageReadme);
