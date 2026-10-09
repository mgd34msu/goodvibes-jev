import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { missingPermission } from './batteries/missing-permission.js';
export const registry = new BatteryRegistry();
registry.register(missingPermission);
