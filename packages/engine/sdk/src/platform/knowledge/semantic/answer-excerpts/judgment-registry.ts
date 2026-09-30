import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { answerExcerptSelection } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(answerExcerptSelection);
