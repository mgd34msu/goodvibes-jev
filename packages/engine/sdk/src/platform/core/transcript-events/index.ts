import { classifyTranscriptMessages, TranscriptReadingLifetime, type TranscriptReadingOptions } from './classify.js';
import { groupTranscriptEvents } from './grouping.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

export { classifyTranscriptMessages, TranscriptReadingLifetime, TranscriptReadingUnsettledError, TranscriptSourceChangedError, type TranscriptReadingOptions } from './classify.js';
export { groupTranscriptEvents } from './grouping.js';
export type { TranscriptEvent, TranscriptEventKind } from './types.js';
export type { TranscriptEventGroup } from './grouping.js';

export async function buildTranscriptEventIndex(messages: readonly ConversationMessageSnapshot[], options: TranscriptReadingOptions = {}) {
  const lifetime = options.lifetime ?? new TranscriptReadingLifetime();
  const events = await classifyTranscriptMessages(messages, { ...options, lifetime });
  lifetime.assertCurrent();
  const groups = groupTranscriptEvents(events);
  return { events, groups };
}
