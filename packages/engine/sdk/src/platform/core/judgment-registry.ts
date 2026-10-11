import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { turnShape } from './batteries/turn-shape.js';
import { planItemStatus } from './batteries/plan-item-status.js';
import { executionStrategy } from './batteries/planner.js';

export const registry = new BatteryRegistry();
registry.register(turnShape);
registry.register(executionStrategy);
registry.register(planItemStatus);

// Spawned-agent observations share the canonical engine registry.
import { projectTestFramework, repeatStuck } from '../agents/batteries/orchestrator-observations.js';
registry.register(projectTestFramework);
registry.register(repeatStuck);
