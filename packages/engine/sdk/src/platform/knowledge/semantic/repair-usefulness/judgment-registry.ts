import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { repairFactUsefulness } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairFactUsefulness);
