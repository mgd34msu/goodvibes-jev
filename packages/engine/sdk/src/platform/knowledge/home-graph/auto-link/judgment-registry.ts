import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { homeGraphDocumentKind, homeGraphDocumentSubject } from './battery.js';
export const registry = new BatteryRegistry();
registry.register(homeGraphDocumentKind);
registry.register(homeGraphDocumentSubject);
