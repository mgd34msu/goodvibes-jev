import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { webGapQuery, webGapRelevance } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(webGapQuery);
registry.register(webGapRelevance);
