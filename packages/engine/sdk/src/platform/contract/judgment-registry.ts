import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { bestOfN } from './batteries/best-of-n.js';
import { criterionShape } from './batteries/criterion-shape.js';
import { criterionTrace } from './batteries/criterion-trace.js';
import { deliverableJudgeDecision } from './batteries/deliverable-judge.js';
import { groupJudgeDecision } from './batteries/group-judge.js';
import { ownerReply } from './batteries/owner-reply.js';
import { planCoverage } from './batteries/plan-coverage.js';
import { requestShape } from './batteries/request-shape.js';
import { stallRoute } from './batteries/stall-route.js';
import { unitShape } from './batteries/unit-shape.js';
import { unitJudgeDecision } from './batteries/unit-judge.js';
import { unitQuality } from './batteries/unit-quality.js';
import { unmetSeverity } from './batteries/unmet-severity.js';

/** Every named decision the contract runner makes, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();

// Planning (section 3).
registry.register(requestShape);
registry.register(criterionTrace);
registry.register(planCoverage);
registry.register(criterionShape);
registry.register(unitShape);

// Checking unit work (section 4.4).
registry.register(unitJudgeDecision);
registry.register(unitQuality);
registry.register(unmetSeverity);

// Correction and finishing (sections 5 and 6).
registry.register(stallRoute);
registry.register(groupJudgeDecision);
registry.register(deliverableJudgeDecision);
registry.register(ownerReply);

// Best-of-N (section 6.2).
registry.register(bestOfN);
