/** The runtime owner also owns the exact fixtures discovered for calibration. */
import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { scheduleReading } from './schedule-reading.js';

export const registry = new BatteryRegistry();
registry.register(scheduleReading);
