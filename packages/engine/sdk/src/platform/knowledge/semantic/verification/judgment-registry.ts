import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { generatedFactFieldSupport, generatedFactSubjectAttachment } from './batteries.js';
/** Run live calibration of these synthetic labelled fixtures before claiming semantic accuracy. */
export const registry = new BatteryRegistry();
registry.register(generatedFactFieldSupport);
registry.register(generatedFactSubjectAttachment);
