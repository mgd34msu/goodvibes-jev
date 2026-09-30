import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { consolidationReading } from './batteries/consolidation.js';
export const registry = new BatteryRegistry();
registry.register(consolidationReading);
