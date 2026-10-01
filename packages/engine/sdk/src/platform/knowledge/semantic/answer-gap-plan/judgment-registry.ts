import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { answerGapAdmission, answerGapEquivalence } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerGapAdmission);
registry.register(answerGapEquivalence);
