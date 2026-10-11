import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { repairSubjectSelection } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(repairSubjectSelection);
