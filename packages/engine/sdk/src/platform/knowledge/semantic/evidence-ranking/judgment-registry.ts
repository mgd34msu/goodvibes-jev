import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { answerEvidenceRelevance } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerEvidenceRelevance);
