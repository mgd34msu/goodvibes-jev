/** Explicit test answers for the daemon approval patterns, never production heuristics. */
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { decisionPort } from './decision-port.ts';
import { securityPort } from './security-readings.ts';

export const REPLY_BATTERY = 'engine.daemon.approval-reply';
export const TARGET_BATTERY = 'engine.daemon.approval-target';

interface Answers {
  reply?: 'approve' | 'reject' | 'amend' | 'unclear';
  confidence?: number;
  target?: string;
  targetConfidence?: number;
  fits?: Readonly<Record<string, number>>;
  unavailable?: 'reply' | 'target';
  beforeReply?: () => Promise<void>;
}

export function useApprovalReadings() {
  let answers: Answers = {};
  let log: SqliteDecisionLog;
  let previous: JudgmentPort | undefined;
  const security = securityPort();
  const own = decisionPort([REPLY_BATTERY, TARGET_BATTERY], (name, question, state) => {
    if (name === 'reading') return choiceAnswer(question, answers.reply ?? 'unclear', answers.confidence ?? 0.97);
    if (name === 'pick') return choiceAnswer(question, answers.target ?? 'none', answers.targetConfidence ?? 0.97);
    const { candidates } = state as { candidates: { id: string }[] };
    const id = candidates[Number(name.slice('fits_'.length))]!.id;
    return noulAnswer(answers.fits?.[id] ?? (id === answers.target ? 0.97 : 0.03));
  });

  beforeEach(() => {
    answers = {};
    own.requests.length = 0;
    log = new SqliteDecisionLog(':memory:');
    const port: JudgmentPort = {
      model: own.port.model,
      async ask(request) {
        const battery = request.context?.battery;
        if (battery !== REPLY_BATTERY && battery !== TARGET_BATTERY) return security.port.ask(request);
        if ((battery === REPLY_BATTERY && answers.unavailable === 'reply')
          || (battery === TARGET_BATTERY && answers.unavailable === 'target')) throw new Error('judgment unavailable');
        if (battery === REPLY_BATTERY) await answers.beforeReply?.();
        return own.port.ask(request);
      },
    };
    previous = installJudgmentPort(withDecisionLog(port, log));
  });
  afterEach(() => {
    installJudgmentPort(previous);
    log[Symbol.dispose]();
  });
  return {
    set: (next: Answers) => { answers = { ...answers, ...next }; },
    requests: own.requests,
    get log() { return log; },
  };
}
