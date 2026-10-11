/**
 * `engine.runtime.pending-approval`: whether one system message reports an
 * approval still waiting on the operator. Read by the session return summary
 * (session-return-context.ts) when the host supplies no structured pending
 * count; code counts the yes readings. One request per system message, all
 * sent together.
 *
 * Band: low stakes. The count is one line of a resume summary; nothing is
 * allowed, denied or blocked because of it.
 */
import { defineBattery, STAKES_BANDS, yesNo, type YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';

export const pendingApproval = defineBattery({
  name: 'engine.runtime.pending-approval',
  version: 1,
  description: 'Whether a system message in a session transcript reports an approval that is still waiting for the operator to allow or deny it.',
  accuracyFloor: 0.9,
  items: {
    pending: yesNo(
      'Does this system message report an approval that is still waiting for the operator, a tool call, command or other action that cannot proceed until the operator allows or denies it? A message saying an approval was already granted, allowed, denied or rejected, or one that only mentions approval settings, is not waiting.',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    { name: 'negated resolution wording', state: '[Approval] This has not been approved; the action is still waiting for your decision.', expect: { pending: 'yes' } },
    { name: 'resolved without old resolution keywords', state: '[Approval] The operator decided against this action. The request is closed.', expect: { pending: 'no' } },
    { name: 'previous rejection with new pending ask', state: '[Approval] The previous request was denied; this new request is waiting for a decision.', expect: { pending: 'yes' } },
    { name: 'waiting for operator input', state: '[Approval] Waiting for operator input', expect: { pending: 'yes' } },
    {
      name: 'exec awaiting a decision',
      state: '[Approval] exec wants to run `rm -rf dist && bun run build` in /home/mike/app. Allow or deny?',
      expect: { pending: 'yes' },
    },
    {
      name: 'write outside the workspace held',
      state: 'Approval required: write_file to /etc/hosts is outside the workspace. The call is held until you decide.',
      expect: { pending: 'yes' },
    },
    {
      name: 'two requests queued',
      state: '[Approval] 2 requests are waiting: edit src/config.ts, exec git push origin main',
      expect: { pending: 'yes' },
    },
    { name: 'already allowed', state: '[Approval] Allowed exec: bun test (approved by operator)', expect: { pending: 'no' } },
    { name: 'already denied', state: '[Approval] Denied write_file to /etc/hosts', expect: { pending: 'no' } },
    {
      name: 'approval setting changed',
      state: '[Policy] Approval mode changed: read-only tools now run without asking.',
      expect: { pending: 'no' },
    },
    { name: 'compaction notice', state: '[Compaction] Compacted context: 142k -> 38k tokens', expect: { pending: 'no' } },
    { name: 'session saved', state: '[Session] Saved session abc123', expect: { pending: 'no' } },
  ],
});

/**
 * Whether one system message reports a pending approval: a yes strong enough
 * to act on. `site` names the decision site for the decision log.
 */
export async function reportsPendingApproval(message: string, site: string): Promise<boolean> {
  const run = await pendingApproval.run(judgmentPort(site), message, { site });
  const reading: YesNoReading = run.readings.pending;
  return reading.verdict === 'yes' && reading.outcome === 'act';
}
