import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { pendingApproval } from '../../runtime/batteries/pending-approval.js';
import { captureTranscriptSnapshot } from './snapshot.js';
import type { ToolCall } from '../../types/tools.js';
import type { TranscriptEvent } from './types.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

function summarizeText(text: string, max = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function classifySystemKind(text: string): TranscriptEvent['kind'] | 'read-approval' {
  if (text.includes('[Remote]') || text.includes('[Teleport]') || text.includes('[Bridge]')) return 'remote_status';
  if (text.includes('[Contract]')) return 'contract_state';
  if (text.includes('[Policy]') || text.includes('[Security]')) return 'policy_warning';
  if (text.includes('[Health]') || text.includes('[Local]') || text.includes('[Scan]') || text.includes('[Forensics]')) return 'diagnostic_notice';
  if (text.includes('[Session]') || text.includes('[Recovery]') || text.includes('[Resume]')) return 'session_restore';
  if (text.includes('[Approval]')) {
    return 'read-approval';
  }
  if (text.includes('[Task]') || text.includes('[Tasks]') || text.includes('[Agent]')) return 'task_transition';
  return 'system_notice';
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
  constructor() { super('Transcript approval reading is unsettled.'); this.name = 'TranscriptReadingUnsettledError'; }
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
  // Only explicit approval protocol messages need semantic classification. Inspect
  // every complete selected text before transmitting any of them; no slicing or
  // unrelated private transcript/tool contents go to the judgment provider.
  const approvals = captured.filter(message => message.role === 'system' && classifySystemKind(message.content) === 'read-approval');
  for (const message of approvals) assertJudgmentInput(message.content);
  const authority = approvals.length ? captureJudgmentPort('core.transcript-events.approval', { ...options, assertCurrent }) : undefined;
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
        const structuralKind = classifySystemKind(message.content);
        let kind: TranscriptEvent['kind'];
        if (structuralKind === 'read-approval') {
          if (!authority) throw new Error('Transcript approval authority is unavailable');
          const result = await pendingApproval.run(authority.port, message.content, { site: 'core.transcript-events.approval', signal: authority.signal, beforeAttempt: authority.assertCurrent });
          authority.assertCurrent();
          const reading = result.readings.pending;
          if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) throw new TranscriptReadingUnsettledError();
          kind = reading.verdict === 'yes' ? 'approval_request' : 'approval_resolution';
          result.recordAction(kind);
          authority.assertCurrent();
        } else kind = structuralKind;
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
