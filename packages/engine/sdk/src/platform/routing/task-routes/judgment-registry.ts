import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { taskRouteNamedId } from './named-ids.js';
import { taskRoutePick } from './route-selector.js';
import { taskRouteSlots } from './slots.js';

/**
 * Every named decision the task route planner makes, for calibration on its
 * own and for merging into the routing registry:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/routing/task-routes/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(taskRoutePick);
registry.register(taskRouteSlots);
registry.register(taskRouteNamedId);
