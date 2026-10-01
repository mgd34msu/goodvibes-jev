import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact } from './batteries.js';
/** Real endpoint calibration is required separately from deterministic fixture plumbing. */
export const registry = new BatteryRegistry();
registry.register(homeGraphTriageApplicability);
registry.register(homeGraphBatteryFacts);
registry.register(homeGraphManualFact);
