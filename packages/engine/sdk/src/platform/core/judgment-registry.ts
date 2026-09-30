import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { turnShape } from './batteries/turn-shape.js';
import { executionStrategy } from './batteries/planner.js';

export const registry = new BatteryRegistry();
registry.register(turnShape);
registry.register(executionStrategy);
