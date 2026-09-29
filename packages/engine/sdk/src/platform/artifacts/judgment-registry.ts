import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { artifactKind } from './batteries/artifact-kind.js';

/**
 * Every named decision the artifact store makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/artifacts/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(artifactKind);
