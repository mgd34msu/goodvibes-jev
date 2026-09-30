import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { answerSourceRerank } from './source-rerank.js';
import { answerFactRerank, answerQueryIntent } from './fact-rerank.js';
import { pageSourceQuality } from './source-quality.js';
export const registry = new BatteryRegistry();
registry.register(answerSourceRerank);
registry.register(answerFactRerank);
registry.register(answerQueryIntent);
registry.register(pageSourceQuality);
