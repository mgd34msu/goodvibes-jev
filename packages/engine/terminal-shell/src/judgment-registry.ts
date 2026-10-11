import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { clusterJoinGroup } from './batteries/cluster-join-group.js';
import { noticeSeverity } from './batteries/notice-severity.js';
import { processOutputError, processOutputEndpoint } from './batteries/process-output.js';

/**
 * Every named decision the terminal shell makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/terminal-shell/src/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(clusterJoinGroup);
registry.register(noticeSeverity);
registry.register(processOutputError);
registry.register(processOutputEndpoint);
