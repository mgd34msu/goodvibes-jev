import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { bestOfN } from './batteries/best-of-n.js';
import { criterionShape } from './batteries/criterion-shape.js';
import { criterionTrace } from './batteries/criterion-trace.js';
import { DELIVERABLE_JUDGES } from './batteries/deliverable-judge.js';
import { escalationTurn } from './batteries/escalation-turn.js';
import { GROUP_JUDGES } from './batteries/group-judge.js';
import { ownerPick } from './batteries/owner-pick.js';
import { ownerReply } from './batteries/owner-reply.js';
import { planCoverage } from './batteries/plan-coverage.js';
import { requestRoute } from './batteries/request-route.js';
import { requestShape } from './batteries/request-shape.js';
import { stallRoute } from './batteries/stall-route.js';
import { unitShape } from './batteries/unit-shape.js';
import { UNIT_JUDGES } from './batteries/unit-judge.js';
import { unitQuality } from './batteries/unit-quality.js';
import { unmetSeverity } from './batteries/unmet-severity.js';

/** Every named decision the contract runner makes, for calibration (`bun run calibrate --registry`). */
export const registry = new BatteryRegistry();

// Intake (section 10.3).
registry.register(requestRoute);
registry.register(escalationTurn);

// Planning (section 3).
registry.register(requestShape);
registry.register(criterionTrace);
registry.register(planCoverage);
registry.register(criterionShape);
registry.register(unitShape);

// Checking unit work (section 4.4).
// Each judge under both acceptance-stakes bands (`contract.acceptanceStakes`), so calibration shows the outcomes each band gives.
registry.register(UNIT_JUDGES.high);
registry.register(UNIT_JUDGES.critical);
registry.register(unitQuality);
registry.register(unmetSeverity);

// Correction and finishing (sections 5 and 6).
registry.register(stallRoute);
registry.register(GROUP_JUDGES.high);
registry.register(GROUP_JUDGES.critical);
registry.register(DELIVERABLE_JUDGES.high);
registry.register(DELIVERABLE_JUDGES.critical);
registry.register(ownerReply);
registry.register(ownerPick);

// Best-of-N (section 6.2).
registry.register(bestOfN);
