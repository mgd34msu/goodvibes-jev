import type { ConversationMessageSnapshot, TokenUsage } from './conversation.ts';
import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ToolCall } from '@goodvibes-jev/engine/sdk/platform/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readContentPart(value: unknown): ContentPart | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text };
  }
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mediaType === 'string') {
    return { type: 'image', data: value.data, mediaType: value.mediaType };
  }
  return null;
}

function readContent(value: unknown): string | ContentPart[] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: ContentPart[] = [];
  for (const entry of value) {
    const part = readContentPart(entry);
    if (!part) return null;
    parts.push(part);
  }
  return parts;
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value) || typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number') return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(typeof value.cacheReadTokens === 'number' ? { cacheReadTokens: value.cacheReadTokens } : {}),
    ...(typeof value.cacheWriteTokens === 'number' ? { cacheWriteTokens: value.cacheWriteTokens } : {}),
  };
}

function readToolCalls(value: unknown): ToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !isRecord(entry.arguments)) return null;
    calls.push({ id: entry.id, name: entry.name, arguments: entry.arguments });
  }
  return calls;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readConversationMessageSnapshot(value: unknown): ConversationMessageSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.role === 'user') {
    const content = readContent(value.content);
    if (content === null) return null;
    const cancelled = hasOwn(value, 'cancelled') ? readBoolean(value.cancelled) : undefined;
    if (hasOwn(value, 'cancelled') && cancelled === undefined) return null;
    return {
      role: 'user',
      content,
      ...(cancelled !== undefined ? { cancelled } : {}),
    };
  }
  if (value.role === 'assistant') {
    const content = readString(value.content);
    if (content === undefined) return null;
    const toolCalls = hasOwn(value, 'toolCalls') ? readToolCalls(value.toolCalls) : undefined;
    if (toolCalls === null) return null;
    const reasoningContent = hasOwn(value, 'reasoningContent') ? readString(value.reasoningContent) : undefined;
    if (hasOwn(value, 'reasoningContent') && reasoningContent === undefined) return null;
    const reasoningSummary = hasOwn(value, 'reasoningSummary') ? readString(value.reasoningSummary) : undefined;
    if (hasOwn(value, 'reasoningSummary') && reasoningSummary === undefined) return null;
    const usage = hasOwn(value, 'usage') ? readTokenUsage(value.usage) : undefined;
    if (hasOwn(value, 'usage') && usage === undefined) return null;
    const model = hasOwn(value, 'model') ? readString(value.model) : undefined;
    if (hasOwn(value, 'model') && model === undefined) return null;
    const provider = hasOwn(value, 'provider') ? readString(value.provider) : undefined;
    if (hasOwn(value, 'provider') && provider === undefined) return null;
    return {
      role: 'assistant',
      content,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
      ...(reasoningSummary !== undefined ? { reasoningSummary } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
  }
  if (value.role === 'system' && typeof value.content === 'string') {
    return { role: 'system', content: value.content };
  }
  if (value.role === 'tool' && typeof value.callId === 'string' && typeof value.content === 'string') {
    const toolName = hasOwn(value, 'toolName') ? readString(value.toolName) : undefined;
    if (hasOwn(value, 'toolName') && toolName === undefined) return null;
    return {
      role: 'tool',
      callId: value.callId,
      content: value.content,
      ...(toolName !== undefined ? { toolName } : {}),
    };
  }
  return null;
}

export function readConversationMessageSnapshots(messages: readonly object[]): ConversationMessageSnapshot[] {
  const snapshots: ConversationMessageSnapshot[] = [];
  for (const [index, message] of messages.entries()) {
    const snapshot = readConversationMessageSnapshot(message);
    if (!snapshot) throw new Error(`Invalid saved conversation message at index ${index}.`);
    snapshots.push(snapshot);
  }
  return snapshots;
}

export function conversationMessagesAsSessionRecords(messages: readonly ConversationMessageSnapshot[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({ ...message }));
}
