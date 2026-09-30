import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { homeGraphQualityBatteries } from './batteries.js';
/** Fake fixtures verify plumbing; live endpoint calibration remains separate. */
export const registry = new BatteryRegistry();
for (const battery of Object.values(homeGraphQualityBatteries)) registry.register(battery);
