import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { consoleStatus } from './console-reading.js';
export const registry = new BatteryRegistry();
registry.register(consoleStatus);

import { googleGrantFailure, googleApiFailure } from './failure-readings.js';
registry.register(googleGrantFailure);
registry.register(googleApiFailure);

import { verificationArtifact } from './verification-reading.js';
registry.register(verificationArtifact);
