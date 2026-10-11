import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { postalAddressExtraction } from './postal-reading.js';
export const registry = new BatteryRegistry();
registry.register(postalAddressExtraction);
