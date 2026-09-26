import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { failureReading } from './failure-reading.js';

/** Every named decision the errors package defines, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();
registry.register(failureReading);
