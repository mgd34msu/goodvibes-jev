import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { clusterJoinGroup } from './batteries/cluster-join-group.js';

/**
 * Every named decision the terminal shell makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/terminal-shell/src/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(clusterJoinGroup);
