/**
 * ACP Protocol Types
 *
 * Re-exports SDK types and defines local types for subagent management.
 * The SDK host acts as the ACP client; subagents implement the Agent interface.
 */

import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';

// Re-export ACP SDK types
export type {
  Client,
  Agent,
  AgentSideConnection,
  ClientSideConnection,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  SessionNotification,
  PromptRequest,
  PromptResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';

/**
 * The ACP SDK's VALUES, `ndJsonStream`, `AgentSideConnection`,
 * `PROTOCOL_VERSION`, `ClientSideConnection`, used to be re-exported from
 * here. They are not any more, because `export { … } from '@agentclientprotocol/sdk'`
 * links the specifier at module init exactly like an import does, and the
 * package is an optionalDependency: an install without it took down every
 * graph that reached this file, the daemon's included. Take them off the
 * awaited module instead:
 *
 *   const { ndJsonStream, ClientSideConnection } = await loadAcpSdk();
 *
 * The type re-exports above are unaffected, `export type` is erased.
 */
export { describeAcpAvailability, loadAcpSdk } from './optional-sdk.js';
export type { AcpAvailability, AcpSdkModule } from './optional-sdk.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** Lifecycle status of a spawned subagent. */
export type SubagentStatus = 'running' | 'complete' | 'error' | 'cancelled';

/** Tracks a live subagent process. */
export interface SubagentInfo {
  id: string;
  task: string;
  status: SubagentStatus;
  startedAt: number;
  /** Latest progress text from session updates. */
  progress?: string | undefined;
}

/** Final result after a subagent completes. */
export interface SubagentResult {
  id: string;
  success: boolean;
  output: string;
  toolCallsMade: number;
  duration: number;
}

/** Parameters for spawning a subagent task. */
export interface SubagentTask {
  /** Human-readable task description / prompt. */
  description: string;
  /** Additional context to inject into the subagent's system prompt. */
  context: string;
  /** Tool names the subagent is allowed to use. */
  tools: string[];
  /** App-owned working directory for the spawned ACP session. */
  workingDirectory: string;
  /** Optional model override (e.g. "claude-sonnet-4-5"). */
  model?: string | undefined;
  /** Optional provider override (e.g. "anthropic"). */
  provider?: string | undefined;
}

/**
 * The answer to an ACP permission request for the owner's decision: the
 * option whose declared `kind` matches it. An approval selects allow_once
 * (allow_always when the decision is remembered), a refusal reject_once
 * (reject_always when remembered). A remembered decision may narrow to once;
 * a one-shot decision never widens to an always option. When the agent offered no
 * option of the needed kind the request is answered cancelled, so an
 * approval is never sent as whatever option happens to come first.
 */
/** The fields of an ACP PermissionOption this answer reads. */
export interface AcpPermissionOptionLike {
  readonly optionId: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export function permissionOutcomeFor(
  options: readonly AcpPermissionOptionLike[],
  decision: { readonly approved: boolean; readonly remember?: boolean | undefined; readonly rememberTier?: unknown },
): RequestPermissionResponse {
  if (new Set(options.map(option => option.optionId)).size !== options.length) return { outcome: { outcome: 'cancelled' } };
  const remembered = decision.remember === true || decision.rememberTier !== undefined;
  const kinds: readonly AcpPermissionOptionLike['kind'][] = decision.approved
    ? (remembered ? ['allow_always', 'allow_once'] : ['allow_once'])
    : (remembered ? ['reject_always', 'reject_once'] : ['reject_once']);
  for (const kind of kinds) {
    const matching = options.filter((candidate) => candidate.kind === kind);
    if (matching.length > 1) return { outcome: { outcome: 'cancelled' } };
    if (matching[0]) return { outcome: { outcome: 'selected', optionId: matching[0].optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}
