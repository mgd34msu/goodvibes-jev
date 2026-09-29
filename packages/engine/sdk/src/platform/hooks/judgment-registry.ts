import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { hookContractSearch } from './batteries/contract-search.js';

/**
 * Every named decision the hooks subsystem makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/hooks/judgment-registry.ts
 */
export const registry = new BatteryRegistry();
registry.register(hookContractSearch);
