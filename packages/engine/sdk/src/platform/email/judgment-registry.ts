import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { emailStyle } from './style-reading.js';
export const registry = new BatteryRegistry();
registry.register(emailStyle);
