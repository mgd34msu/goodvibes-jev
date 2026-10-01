import type { ContentPart, ProviderMessage } from '../providers/interface.js';
import type { ConversationMessageSnapshot } from './conversation.js';

type Message = ConversationMessageSnapshot;

export function cloneMessages(messages: Message[]): Message[] {
  return structuredClone(messages);
}

function extractAssistantText(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toInternalMessage(message: ProviderMessage): Message {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : structuredClone(message.content as ContentPart[]),
    };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: extractAssistantText(message.content),
      ...(message.toolCalls?.length ? { toolCalls: structuredClone(message.toolCalls) } : {}),
    };
  }
  const toolMsg = message as { role: 'tool'; callId: string; content: string | unknown; name?: string };
  return {
    role: 'tool',
    callId: toolMsg.callId ?? '',
    content: typeof toolMsg.content === 'string' ? toolMsg.content : String(toolMsg.content),
    ...(typeof toolMsg.name === 'string' && toolMsg.name.length > 0 ? { toolName: toolMsg.name } : {}),
  };
}

export function messagesToInternal(messages: ProviderMessage[]): Message[] {
  return messages.map(toInternalMessage);
}

/** Compare the complete model-facing projection, never outcome prose or model names. */
function providerKey(message: ProviderMessage): string {
  switch (message.role) {
    case 'user': return JSON.stringify([message.role, message.content]);
    case 'assistant': return JSON.stringify([message.role, message.content, message.toolCalls ?? []]);
    case 'tool': return JSON.stringify([message.role, message.callId, message.content, message.name ?? null]);
  }
}

/**
 * Restore a compaction's retained messages whole, including non-provider metadata.
 * The cached provider list maps one-to-one to non-system stored messages. Kept
 * object identity is authoritative. An exact, uniquely matching copy can also
 * retain its source; ambiguous copies stay metadata-free rather than borrowing
 * another occurrence's model, usage, cancellation or outcome. Every source is
 * consumed at most once. Newly written messages are converted with tool calls.
 */
export function restoreKeptMessages(
  kept: readonly ProviderMessage[],
  llm: readonly ProviderMessage[],
  stored: readonly Message[],
): Message[] {
  const nonSystem = stored.filter((message) => message.role !== 'system');
  if (nonSystem.length !== llm.length || llm.some((message, index) => message.role !== nonSystem[index]!.role)) {
    return kept.map(toInternalMessage);
  }
  const sourceKeys = nonSystem.map((message) => {
    if (message.role === 'tool') {
      return providerKey({ role: 'tool', callId: message.callId, content: message.content, name: message.toolName });
    }
    if (message.role === 'assistant') {
      return providerKey({ role: 'assistant', content: message.content,
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) });
    }
    return providerKey(message);
  });
  if (llm.some((message, index) => providerKey(message) !== sourceKeys[index])) {
    return kept.map(toInternalMessage);
  }
  const byIdentity = new Map(llm.map((message, index) => [message, index]));
  const byValue = new Map<string, number[]>();
  llm.forEach((message, index) => {
    const key = providerKey(message);
    const indices = byValue.get(key) ?? [];
    indices.push(index);
    byValue.set(key, indices);
  });
  const used = new Set<number>();
  return kept.map((message) => {
    let index = byIdentity.get(message);
    if (index === undefined) {
      const candidates = byValue.get(providerKey(message)) ?? [];
      if (candidates.length === 1) index = candidates[0];
    }
    if (index === undefined || used.has(index)) return toInternalMessage(message);
    used.add(index);
    return structuredClone(nonSystem[index]!);
  });
}

export function cloneBranchMap(branches: Map<string, Message[]>): Record<string, Message[]> {
  const result: Record<string, Message[]> = {};
  for (const [name, msgs] of branches) {
    result[name] = cloneMessages(msgs);
  }
  return result;
}

export function restoreBranchMap(branches?: Record<string, Message[]>): Map<string, Message[]> {
  const restored = new Map<string, Message[]>();
  if (!branches) return restored;
  for (const [name, msgs] of Object.entries(branches)) {
    restored.set(name, cloneMessages(msgs));
  }
  return restored;
}

export function deriveConversationTitle(content: string): string {
  const text = content.trim();
  if (text.length <= 50) return text;
  let cut = text.lastIndexOf(' ', 50);
  if (cut <= 0) cut = 50;
  return text.slice(0, cut);
}

export function extractUserDisplayText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  const textParts = content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
  const imageCount = content.filter((part) => part.type === 'image').length;
  return textParts.map((part) => part.text).join('') + (imageCount > 0 ? ` [+${imageCount} image(s)]` : '');
}
