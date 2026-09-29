/**
 * permissionOutcomeFor answers an ACP permission request with the option
 * whose declared kind matches the owner's decision, never with whichever
 * option the agent happened to list first.
 */
import { describe, expect, test } from 'bun:test';
import { permissionOutcomeFor } from '../sdk/src/platform/acp/protocol.ts';

const rejectFirst = [
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
  { optionId: 'no-ever', name: 'Always reject', kind: 'reject_always' as const },
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'yes-ever', name: 'Always allow', kind: 'allow_always' as const },
];

describe('ACP permission answer by option kind', () => {
  test('an approval selects allow_once, a remembered one allow_always', () => {
    expect(permissionOutcomeFor(rejectFirst, { approved: true })).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(permissionOutcomeFor(rejectFirst, { approved: true, remember: true })).toEqual({ outcome: { outcome: 'selected', optionId: 'yes-ever' } });
  });

  test('a refusal selects reject_once, a remembered one reject_always', () => {
    expect(permissionOutcomeFor(rejectFirst, { approved: false })).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(permissionOutcomeFor(rejectFirst, { approved: false, rememberTier: 'session' })).toEqual({ outcome: { outcome: 'selected', optionId: 'no-ever' } });
  });

  test('the other variant of the decision is used when the preferred one is not offered', () => {
    expect(permissionOutcomeFor([rejectFirst[3]!], { approved: true })).toEqual({ outcome: { outcome: 'selected', optionId: 'yes-ever' } });
  });

  test('an approval with no allow option offered is answered cancelled, not with a reject', () => {
    expect(permissionOutcomeFor(rejectFirst.slice(0, 2), { approved: true })).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
