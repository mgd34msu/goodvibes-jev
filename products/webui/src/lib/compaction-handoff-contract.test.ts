import { describe, expect, test } from 'bun:test';
import { COMPACTION_HANDOFF_HEADER, isCompactionHandoffMessage } from './compaction';
// The SDK's platform/core barrel is not browser-safe, so compaction.ts carries
// its own copy of the header. A handoff the daemon writes with the SDK's header
// must still be recognized here.
import { COMPACTION_HANDOFF_HEADER as SDK_HEADER } from '@goodvibes-jev/engine/sdk/platform/core';

describe('compaction handoff header contract', () => {
  test('a handoff written with the SDK header is recognized', () => {
    expect(isCompactionHandoffMessage(`${SDK_HEADER}\n\n## Standing Instructions`)).toBe(true);
  });

  test('isCompactionHandoffMessage matches only the handoff message', () => {
    expect(isCompactionHandoffMessage(`${COMPACTION_HANDOFF_HEADER}\n\n## Standing Instructions`)).toBe(true);
    expect(isCompactionHandoffMessage('please compact my context')).toBe(false);
    expect(isCompactionHandoffMessage('')).toBe(false);
  });
});
