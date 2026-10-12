import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { knowledgeExtractionValue } from './battery.js';

export const registry = new BatteryRegistry();
registry.register(knowledgeExtractionValue);
