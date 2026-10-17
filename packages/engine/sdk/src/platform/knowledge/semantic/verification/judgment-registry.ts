import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { generatedFactFieldSupport, generatedFactSubjectAttachment } from './batteries.js';

export const registry = new BatteryRegistry();
registry.register(generatedFactFieldSupport);
registry.register(generatedFactSubjectAttachment);
