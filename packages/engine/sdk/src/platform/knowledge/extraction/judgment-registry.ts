import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { extractionReadability, pdfTextDecoding } from '../batteries/extraction-readability.js';

/** Extraction decisions, independently discoverable by calibration and lint. */
export const registry = new BatteryRegistry();
registry.register(extractionReadability);
registry.register(pdfTextDecoding);
