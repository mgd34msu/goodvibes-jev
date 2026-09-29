import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the offline source and release gates read from stored
 * readings, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/scripts/ci-readings/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Whether a package README documents the package, and whether its wording is stale (package metadata check).
import { packageReadme } from './package-readme.ts';
registry.register(packageReadme);

// Whether a free-text SBOM license name is AGPL, GPL, LGPL or SSPL (sbom license policy).
import { copyleftLicense } from './copyleft-license.ts';
registry.register(copyleftLicense);
