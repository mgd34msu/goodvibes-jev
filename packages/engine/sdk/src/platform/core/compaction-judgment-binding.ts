import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';

const SITE = 'core.context-compaction';
const currentPort = () => {
  try { return judgmentPort(SITE); }
  catch (error) { if (error instanceof JudgmentPortMissingError) return undefined; throw error; }
};

/**
 * Hold the existing composition's binding across generation, readings and
 * commit. The composition still owns retry/disposal. Absence is captured too:
 * an older compaction cannot borrow a port installed while generation waited.
 */
export function captureCompactionJudgment(): () => void {
  const port = currentPort();
  const model = port?.model;
  return () => {
    if (currentPort() !== port || port?.model !== model) {
      throw new JudgmentError('aborted', 'Judgment composition changed during compaction; current conversation retained.');
    }
  };
}
