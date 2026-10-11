import type { Questions } from '@goodvibes-jev/judgment';
import { admitJudgmentJson, captureStrictJudgmentJson, prepareJudgmentResult } from '../../../gate/judgment-result.js';
import { KnowledgeWebGapRepairHeldError } from './types.js';

const held = (reason: 'malformed' | 'stale') => new KnowledgeWebGapRepairHeldError(reason);
export const captureStrictRepairJson = <T>(value: T): T => captureStrictJudgmentJson(value, held);
export const admitRepairJson = <T>(value: T): T => admitJudgmentJson(value, held);
export const prepareRepairJudgmentResult = (questions: Questions) => prepareJudgmentResult(questions, held);
