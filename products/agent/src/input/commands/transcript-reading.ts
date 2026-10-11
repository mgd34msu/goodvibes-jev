/** UI observation owned by the current conversation/session, never execution permission. */
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { TranscriptSourceChangedError, TranscriptReadingLifetime } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext } from '../command-registry.ts';

export const TRANSCRIPT_UNAVAILABLE = 'Transcript index is unavailable right now. Try again; your messages are unchanged.';
export function captureTranscriptSource(ctx: CommandContext, signal?: AbortSignal) {
  const lifetime = new TranscriptReadingLifetime();
  const manager = ctx.session.sessionManager;
  const conversation = ctx.session.conversationManager;
  const runtime = ctx.session.runtime;
  const sessionId = runtime?.sessionId;
  const messages = JSON.stringify(conversation.getMessageSnapshot());
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (ctx.session.sessionManager !== manager || ctx.session.conversationManager !== conversation || ctx.session.runtime !== runtime || runtime?.sessionId !== sessionId || JSON.stringify(conversation.getMessageSnapshot()) !== messages) throw new TranscriptSourceChangedError();
  };
  lifetime.retain(assertCurrent);
  return { conversation, assertCurrent, lifetime, signal, assertPublishable: () => lifetime.assertCurrent() };
}
export function transcriptReadingCanceled(error: unknown): boolean {
  return error instanceof TranscriptSourceChangedError || error instanceof JudgmentAuthorityRetiredError;
}
export async function readTranscriptIndex(ctx: CommandContext, source = captureTranscriptSource(ctx)) {
  try {
    const index = await source.conversation.getTranscriptEventIndex({ assertCurrent: source.assertCurrent, lifetime: source.lifetime, signal: source.signal });
    source.assertPublishable();
    return index;
  } catch (error) {
    source.assertPublishable();
    if (transcriptReadingCanceled(error)) throw error;
    // Neither provider errors nor transcript content are echoed into a display.
    return null;
  }
}
