import { prepareJudgmentResult } from '../../gate/judgment-result.js';
import { systemMessagePresentation } from '../../runtime/system-message-presentation.js';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { captureTranscriptSnapshot } from './snapshot.js';
import type { ToolCall } from '../../types/tools.js';
import type { TranscriptEvent } from './types.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

function summarizeText(text: string, max = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function toolCallEvents(messageIndex: number, toolCalls: readonly ToolCall[]): TranscriptEvent[] {
  return toolCalls.map((call, index) => ({
    id: `msg-${messageIndex}-tool-call-${index}`,
    kind: 'tool_call',
    messageIndex,
    groupKey: `tool:${call.id}`,
    title: call.name,
    detail: summarizeText(JSON.stringify(call.arguments ?? {})),
    relatedCallId: call.id,
  }));
}

/** A replaced/cancelled source must not publish an index or stale UI update. */
export class TranscriptSourceChangedError extends Error {
  constructor() { super('Transcript source changed.'); this.name = 'TranscriptSourceChangedError'; }
}
/** Unsettled meaning is not a resolved approval and does not publish an index. */
export class TranscriptReadingUnsettledError extends Error {
  constructor() { super('Transcript presentation reading is unsettled.'); this.name = 'TranscriptReadingUnsettledError'; }
}
/** Carries the original reading authority across every asynchronous publication boundary. */
export class TranscriptReadingLifetime {
  private readonly checks = new Set<() => void>();
  public retain(check: () => void): void { this.checks.add(check); }
  public assertCurrent(): void { for (const check of this.checks) check(); }
}
export interface TranscriptReadingOptions extends JudgmentReadingOptions {
  readonly lifetime?: TranscriptReadingLifetime;
}

export async function classifyTranscriptMessages(messages: readonly ConversationMessageSnapshot[], options: TranscriptReadingOptions = {}): Promise<TranscriptEvent[]> {
  const lifetime = options.lifetime ?? new TranscriptReadingLifetime();
  const captured = captureTranscriptSnapshot(messages) as readonly ConversationMessageSnapshot[];
  const source = JSON.stringify(captured);
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    const checked: unknown = options.assertCurrent?.();
    if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new Error('Transcript source checks must be synchronous'); }
    if (JSON.stringify(captureTranscriptSnapshot(messages)) !== source) throw new TranscriptSourceChangedError();
  };
  assertCurrent();
  // Preflight every complete system notice before transmitting any of them.
  // User, assistant and tool contents remain outside this presentation reading.
  const notices = captured.filter(message => message.role === 'system');
  for (const message of notices) assertJudgmentInput({ content: message.content });
  const authority = notices.length ? captureJudgmentPort(systemMessagePresentation.name, { ...options, assertCurrent, prepareResultCapture: prepareJudgmentResult }) : undefined;
  lifetime.retain(assertCurrent);
  if (authority) lifetime.retain(authority.assertCurrent);
  const events: TranscriptEvent[] = [];
  for (const [messageIndex, message] of captured.entries()) {
    switch (message.role) {
      case 'user': {
        const content = typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.type === 'text' ? part.text : '[image]').join(' ');
        events.push({
          id: `msg-${messageIndex}-user`,
          kind: 'user_input',
          messageIndex,
          groupKey: `user:${messageIndex}`,
          title: 'User input',
          detail: summarizeText(content),
        });
        break;
      }
      case 'assistant': {
        if (message.content.trim()) {
          events.push({
            id: `msg-${messageIndex}-assistant`,
            kind: 'assistant_output',
            messageIndex,
            groupKey: `assistant:${messageIndex}`,
            title: 'Assistant output',
            detail: summarizeText(message.content),
          });
        }
        if (message.toolCalls?.length) {
          events.push(...toolCallEvents(messageIndex, message.toolCalls));
        }
        break;
      }
      case 'tool':
        events.push({
          id: `msg-${messageIndex}-tool-result`,
          kind: 'tool_result',
          messageIndex,
          groupKey: `tool:${message.callId}`,
          title: message.toolName ?? 'Tool result',
          detail: summarizeText(message.content),
          relatedCallId: message.callId,
        });
        break;
      case 'system': {
        if (!authority) throw new TranscriptReadingUnsettledError();
        const result = await systemMessagePresentation.run(authority.port, { content: message.content }, {
          site: 'core.transcript-events.presentation', signal: authority.signal, beforeAttempt: authority.assertCurrent,
        });
        authority.assertCurrent();
        const reading = result.readings.event;
        if (reading.outcome !== 'act') throw new TranscriptReadingUnsettledError();
        const kind: TranscriptEvent['kind'] = reading.choice;
        result.recordAction(`transcript presentation:${kind}`);
        authority.assertCurrent();
        events.push({
          id: `msg-${messageIndex}-system`,
          kind,
          messageIndex,
          groupKey: `${kind}:${messageIndex}`,
          title: kind.replace(/_/g, ' '),
          detail: summarizeText(message.content),
        });
        break;
      }
    }
  }
  assertCurrent();
  lifetime.assertCurrent();
  return events;
}
