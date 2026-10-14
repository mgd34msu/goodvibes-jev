import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { consoleStatus } from './console-reading.js';
export const registry = new BatteryRegistry();
registry.register(consoleStatus);
