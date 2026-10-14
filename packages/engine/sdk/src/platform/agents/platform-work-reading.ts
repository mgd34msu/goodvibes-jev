import { prepareJudgmentResult } from '../gate/judgment-result.js';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { agentReadScope } from '../gate/batteries/agent-read-scope.js';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';
/** The existing platform-scope battery also owns the write/edit request interpretation. */
export async function readRequestedPlatformWork(message: string, signal?: AbortSignal, options: JudgmentReadingOptions = {}): Promise<boolean> {
  const state = { path: 'GoodVibes platform implementation', source: { goal: message, criteria: [] } };
  assertJudgmentInput(state);
  if (JSON.stringify(state).length > 160_000) throw new JudgmentInputError('unsupported-input');
  const owner = captureJudgmentPort(agentReadScope.name, { ...options, signal: signal ?? options.signal, prepareResultCapture: prepareJudgmentResult });
  const run = await agentReadScope.run(owner.port, state, { only: ['platform_requested'], site: 'agent.platform-write-scope', beforeAttempt: owner.assertCurrent, signal: owner.signal });
  owner.assertCurrent(); const reading = requireActingReading(run.readings.platform_requested);
  run.recordAction('Check the original request scope; this does not grant write permission.');
  return reading.verdict === 'yes';
}
