import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { repairSourceAuthority } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairSourceAuthority);
