import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { repositoryFailureReading } from './bookkeeping.js';
export const registry = new BatteryRegistry();
registry.register(repositoryFailureReading);
