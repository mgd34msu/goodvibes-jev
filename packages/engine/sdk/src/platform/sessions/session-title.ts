/** Shared, bounded text generation for optional session titles. */
import type { ConversationMessageSnapshot } from '../core/conversation.js';

/** The configured tool/helper model supplied by the host. */
export interface SessionTitleModel {
  chat(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
}

/** One attempt per owner; missing input does not consume it. */
export interface SessionTitleGenerator {
  /**
   * Reads input only before an attempt has been claimed. Returns null for
   * missing input, a used attempt, failed generation or an empty reply.
   */
  generate(readMessages: () => readonly ConversationMessageSnapshot[]): Promise<string | null>;
}

const MAX_TITLE_CHARS = 60;
const TITLE_SYSTEM_PROMPT =
  'You write terse chat titles. Reply with ONLY a 3 to 6 word title, Title Case, no surrounding quotes, no trailing punctuation, no preamble.';

/** Extract plain text from a user message's content. */
function userText(snapshot: readonly ConversationMessageSnapshot[]): string | null {
  for (const message of snapshot) {
    if (message.role !== 'user') continue;
    const { content } = message;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    const text = content
      .map((part) => (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join(' ')
      .trim();
    if (text) return text;
  }
  return null;
}

/** Reduce a model reply to a clean single-line title. */
export function sanitizeSessionTitle(raw: string): string | null {
  const firstLine = (raw.split('\n', 1)[0] ?? '').trim();
  const unquoted = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  const cleaned = unquoted.replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_TITLE_CHARS ? cleaned.slice(0, MAX_TITLE_CHARS).trim() : cleaned;
}

/**
 * Owns title prompt, input/output bounds and the single attempt. The host owns
 * opt-in settings, session lifetime and applying the result. A failed, empty
 * or discarded result must not be retried by recreating this owner.
 */
export function createSessionTitleGenerator(model: SessionTitleModel): SessionTitleGenerator {
  let attempted = false;
  return {
    async generate(readMessages): Promise<string | null> {
      if (attempted) return null;
      const first = userText(readMessages());
      if (!first) return null;
      attempted = true; // Claim before awaiting, including bursts of turn events.
      try {
        const reply = await model.chat(
          `Title this conversation. First user message:\n"""${first.slice(0, 2000)}"""`,
          { maxTokens: 24, systemPrompt: TITLE_SYSTEM_PROMPT },
        );
        return sanitizeSessionTitle(reply);
      } catch {
        return null;
      }
    },
  };
}
