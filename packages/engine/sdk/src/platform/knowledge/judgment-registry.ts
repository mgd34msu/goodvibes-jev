import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { consolidationReading } from './batteries/consolidation.js';
import { planningAnswerTopic, planningRecommendationSpecific } from './project-planning/batteries/answer-actions.js';
export const registry = new BatteryRegistry();
registry.register(consolidationReading);
registry.register(planningAnswerTopic);
registry.register(planningRecommendationSpecific);

import { repairFailureCause } from './semantic/self-improvement-failure-battery.js';
registry.register(repairFailureCause);
