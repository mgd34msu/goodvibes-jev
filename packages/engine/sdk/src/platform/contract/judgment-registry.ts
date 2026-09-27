import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { criterionShape } from './batteries/criterion-shape.js';
import { criterionTrace } from './batteries/criterion-trace.js';
import { planCoverage } from './batteries/plan-coverage.js';
import { requestShape } from './batteries/request-shape.js';
import { unitShape } from './batteries/unit-shape.js';

/** Every named decision the contract runner makes, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();

// Planning (section 3).
registry.register(requestShape);
registry.register(criterionTrace);
registry.register(planCoverage);
registry.register(criterionShape);
registry.register(unitShape);
