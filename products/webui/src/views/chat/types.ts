import type { CompletedToolCall } from './message-utils';

/**
 * Represents a chat message as it flows through the UI layer.
 *
 * Messages may originate from local optimistic state (LocalCompanionMessage) or
 * from the server response (open shape). All known fields are declared explicitly;
 * the index signature admits additional server-provided properties without `any`.
 */
export interface ChatMessage {
  /** Primary message identifier. */
  id?: string;
  /** Alternative id key used by some server shapes. */
  messageId?: string;
  /** Session this message belongs to. */
  sessionId?: string;
  /** Speaker role. */
  role?: string;
  /** Alternative role keys. */
  author?: string;
  kind?: string;
  source?: string;
  /** Primary text content. */
  content?: string;
  /** Alternative text keys. */
  text?: string;
  body?: string;
  message?: string;
  delta?: string;
  /** Structured content parts (multi-modal messages). */
  parts?: readonly { text?: string; content?: string; body?: string; [key: string]: unknown }[];
  /** File / artifact attachments. */
  attachments?: readonly {
    artifactId?: string;
    id?: string;
    label?: string;
    filename?: string;
    name?: string;
    mimeType?: string;
    type?: string;
    sizeBytes?: number;
    size?: number;
    [key: string]: unknown;
  }[];
  /** Some server shapes use 'artifacts' instead of 'attachments'. */
  artifacts?: readonly Record<string, unknown>[];
  /** Optimistic delivery state (local messages only). */
  deliveryState?: string;
  /** Alternative state keys from server shapes. */
  status?: string;
  state?: string;
  /** Creation timestamp (epoch ms). */
  createdAt?: number;
  /** Alternative timestamp keys. */
  timestamp?: number;
  time?: number;
  /**
   * Completed tool calls for the turn that produced this message, populated
   * client-side from the live event stream (see useChatStream's
   * toolActivityByMessageId). Present only for a turn this browser tab
   * watched run live in the current stream session, absent (not empty) for
   * any message rehydrated purely from server history, since the daemon's
   * persisted message shape carries no tool data.
   */
  toolActivity?: readonly CompletedToolCall[];
  /** Allow additional server-provided fields without `any`. */
  [key: string]: unknown;
}

export interface ChatViewProps {
  activeSessionId: string;
  sessionItems: unknown[];
  onActiveSessionChange: (sessionId: string) => void;
  onDraftSessionRequestedChange: (requested: boolean) => void;
  onLocalSessionCreated: (session: unknown) => void;
  onLocalSessionUpdated: (sessionId: string, session: unknown) => void;
  onSessionMissing: (sessionId: string) => void;
  /**
   * The signed-in person's name for the new-chat greeting ("Good evening,
   * Mike"). Absent or empty greets without a name.
   */
  userName?: string;
}
