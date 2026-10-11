/**
 * Public option and observation types for McpClient.
 */
import type { McpElicitationContext } from './elicitation-autonomous.js';
import type { JsonRpcId } from './jsonrpc.js';

export interface McpProcessSpec {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  summary?: string | undefined;
  sandboxSessionId?: string | undefined;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpToolSchema extends McpToolInfo {
  inputSchema: Record<string, unknown>;
  /** Server-declared presentation hints; never a permission grant. */
  annotations?: {
    readonly readOnlyHint?: boolean | undefined;
    readonly destructiveHint?: boolean | undefined;
    readonly idempotentHint?: boolean | undefined;
    readonly openWorldHint?: boolean | undefined;
  } | undefined;
}

/** Additive restrictions from the actual caller, never execution authority. */
export interface McpToolCallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Require the exact schema returned by this native owner; never a grant. */
  readonly expectedSchema?: McpToolSchema | undefined;
}

export interface McpClientNotification {
  serverName: string;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientServerRequest {
  serverName: string;
  id: JsonRpcId;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientUnhandledResponse {
  serverName: string;
  id: JsonRpcId | null;
  hasError: boolean;
  error?: string | undefined;
}

/**
 * A resolver for the MCP `elicitation/create` server→client request. When
 * wired, the client advertises the `elicitation` capability at handshake and
 * routes incoming elicitation requests here instead of hard-rejecting them with
 * `-32601`; the resolved outcome is written back as the JSON-RPC result.
 * Modern-era servers deliver elicitation as Multi Round-Trip Request input
 * requests on tool calls; those route through the same resolver.
 */
export type McpElicitationResolver = (input: {
  serverName: string;
  id: JsonRpcId;
  params?: unknown | undefined;
  context?: McpElicitationContext | undefined;
}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> | undefined }>;

export interface McpClientOptions {
  /** Live owner check immediately before every initial or restarted process spawn. */
  beforeProcessStart?: (() => void) | undefined;
  timeout?: number | undefined;
  processSpec?: McpProcessSpec | undefined;
  onNotification?: ((notification: McpClientNotification) => void) | undefined;
  onServerRequest?: ((request: McpClientServerRequest) => void) | undefined;
  onUnhandledResponse?: ((response: McpClientUnhandledResponse) => void) | undefined;
  /**
   * When set, `elicitation/create` server requests are resolved through this
   * handler (which brokers them to the approval channel) rather than dropped.
   */
  onElicitation?: McpElicitationResolver | undefined;
  /** Injectable fetch for the Streamable HTTP transport (tests). */
  fetchImpl?: typeof fetch | undefined;
}
