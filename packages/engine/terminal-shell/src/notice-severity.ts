import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { noticeSeverity, type NoticeSeverity } from './batteries/notice-severity.js';

export interface NoticeSeverityReading {
  readonly severity: NoticeSeverity | undefined;
  readonly assertCurrent: () => void;
  /** Record and fence publication immediately before the caller's display effect. */
  readonly recordPublication: () => void;
}

/** Full-input privacy screening precedes port capture, logging and transmission. */
export async function readNoticeSeverity(text: string, options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {}): Promise<NoticeSeverityReading> {
  snapshotJudgmentInput({ text });
  const owner = captureJudgmentPort('terminal-shell.notice-severity', { ...options, prepareResultCapture: prepareJudgmentResult });
  const run = await noticeSeverity.run(owner.port, { text }, { site: 'terminal-shell.notice-severity', signal: owner.signal });
  owner.assertCurrent();
  const reading = run.readings.severity;
  const severity = reading.outcome === 'act' && reading.choice !== 'unknown' ? reading.choice : undefined;
  if (severity === undefined) { run.recordAction('notice-held'); owner.assertCurrent(); }
  return { severity, assertCurrent: owner.assertCurrent, recordPublication() {
    owner.assertCurrent();
    run.recordAction(severity === undefined ? 'notice-held' : `notice-published:${severity}`);
    owner.assertCurrent();
  } };
}
