import { isProxy } from 'node:util/types';
/**
 * AcpConnection, Per-subagent ACP connection.
 *
 * Spawns a child process via Bun.spawn and connects to it via ClientSideConnection
 * using ndJsonStream over stdio. Implements the ACP Client interface so the
 * subagent can request permissions and send session updates.
 */

// `@agentclientprotocol/sdk` is an optionalDependency: its values are taken
// off the awaited module in acp/optional-sdk.ts at the point the connection is
// built, never imported at module init. The type import below is erased.
import { loadAcpSdk } from './optional-sdk.js';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type {
  Client,
  Agent,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from './protocol.js';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.js';
import { permissionOutcomeFor, type AcpPermissionOptionLike } from './protocol.js';
import { admitExternalRequest, type ExternalPermissionHost, type ExternalOperationSource } from '../permissions/external-request.js';
import { AcpPermissionWire } from './permission-wire.js';
import type { PermissionRequestHandler } from '../permissions/prompt.js';
import { logger } from '../utils/logger.js';
import { AcpError } from '../types/errors.js';
import { VERSION } from '../version.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentStreamDelta,
  emitTransportAuthenticating,
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportSyncing,
  emitTransportTerminalFailure,
} from '../runtime/emitters/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import { summarizeError } from '../utils/error-display.js';
import type { AgentUsage } from '../../events/agents.js';

/** Shape of an agent_message_chunk session update that carries text content. */
interface MessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content?: Array<{ type: string; text?: string }> | undefined;
}

/** Runtime type guard for agent_message_chunk updates. */
function isMessageChunk(update: { sessionUpdate?: unknown }): update is MessageChunkUpdate {
  return (
    update.sessionUpdate === 'agent_message_chunk' &&
    ('content' in update)
  );
}

/** Shape of the (experimental/unstable) ACP `PromptResponse.usage` field. */
interface AcpPromptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

/**
 * Map the ACP prompt response's usage field (`cachedReadTokens`/`cachedWriteTokens`,
 * ACP protocol naming) onto the SDK's `AgentUsage` shape (`cacheReadTokens`/
 * `cacheWriteTokens`). Exported for unit testing without spawning a real
 * ACP subprocess.
 */
export function mapAcpUsage(usage: AcpPromptUsage | null | undefined): AgentUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens != null ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
  };
}

/**
 * AcpConnection manages the lifecycle of a single subagent child process.
 *
 * Lifecycle:
 *   1. Construct with spawn params
 *   2. Call run(), spawns child, performs ACP handshake, starts a session
 *   3. Resolves with SubagentResult when the subagent completes or is cancelled
 *   4. Call cancel() to abort
 */
export class AcpConnection {
  public readonly id: string;
  private info: SubagentInfo;
  private spawnCmd: string[];
  private readonly lifetime = new AbortController();
  private permissionWire: AcpPermissionWire | undefined;
  private runtimeBus: RuntimeEventBus | null;
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private childProcess: ReturnType<typeof Bun.spawn> | null = null;
  private toolCallsMade = 0;
  private lastProgressText = '';
  private transportClosed = false;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;

  constructor(
    id: string,
    private task: SubagentTask,
    spawnCmd: string[],
    _requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    runtimeBus: RuntimeEventBus | null = null,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
    private readonly permissionHost?: ExternalPermissionHost,
    private readonly operation?: ExternalOperationSource,
  ) {
    this.id = id;
    this.task = { ...task, tools: [...task.tools] };
    this.spawnCmd = [...spawnCmd];
    this.runtimeBus = runtimeBus;
    this.hookDispatcher = hookDispatcher;
    this.info = {
      id,
      task: task.description,
      status: 'running',
      startedAt: Date.now(),
    };
  }

  /** Current info snapshot. */
  getInfo(): SubagentInfo {
    return { ...this.info };
  }

  /**
   * Spawn the child process, perform the ACP handshake, and run the prompt.
   * Resolves with SubagentResult when the subagent completes or errors.
   */
  async run(): Promise<SubagentResult> {
    const startedAt = this.info.startedAt;

    try {
      this.lifetime.signal.throwIfAborted();
      this.transportClosed = false;
      this.emitTransportInitializing();

      // 0. Resolve the ACP SDK. Inside the try, so an install without the
      //    optional package fails this subagent run with a message naming it
      //    rather than preventing the process from starting.
      const { ClientSideConnection, ndJsonStream } = await loadAcpSdk();
      this.lifetime.signal.throwIfAborted();

      // 1. Spawn child process with piped stdio
      this.childProcess = Bun.spawn(this.spawnCmd, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // 2. Build ndJsonStream from child stdio.
      //
      // In Bun, childProcess.stdin is a FileSink (not a Web WritableStream).
      // ndJsonStream requires a Web WritableStream<Uint8Array> so it can call
      // .getWriter() internally.  Wrap the FileSink in a WritableStream adapter.
      if (!this.childProcess.stdin) {
        throw new AcpError('ACP subprocess stdin not available, was it spawned with stdin: "pipe"?');
      }
      const bunStdin = this.childProcess.stdin as import('bun').FileSink;
      const stdinStream = new WritableStream<Uint8Array>({
        write(chunk) {
          bunStdin.write(chunk);
        },
        close() {
          bunStdin.end();
        },
        abort() {
          bunStdin.end();
        },
      });

      const stream = ndJsonStream(
        stdinStream,
        // Bun's piped stdout is ReadableStream-shaped at runtime, getReader() works
        // correctly. The double-cast is safe here because Bun's ReadStream implements the
        // same interface, unlike stdin (FileSink) which lacks getWriter().
        this.childProcess.stdout as unknown as ReadableStream<Uint8Array>,
      );

      const ownedChild = this.childProcess;
      this.permissionWire = new AcpPermissionWire(() => {
        const sessionId = this.sessionId;
        const invalidation = new AbortController();
        const unsubscribe = this.permissionHost?.config.onDidInvalidate(() => invalidation.abort()) ?? (() => {});
        return { assertCurrent: () => {
          this.lifetime.signal.throwIfAborted(); invalidation.signal.throwIfAborted();
          this.permissionHost?.signal.throwIfAborted(); this.operation?.signal?.throwIfAborted();
          this.operation?.assertCurrent();
          if (!sessionId || this.sessionId !== sessionId || this.childProcess !== ownedChild) throw new Error('ACP permission owner changed');
        }, close: unsubscribe };
      });
      const wire = this.permissionWire;
      type WireMessage = typeof stream.readable extends ReadableStream<infer Message> ? Message : never;
      const readable = stream.readable.pipeThrough(new TransformStream<WireMessage, WireMessage>({ transform(message, controller) {
        wire.observe(message); controller.enqueue(message);
      } }));
      const writable = new WritableStream<WireMessage>({
        write(message) { wire.write(message, bytes => { bunStdin.write(bytes); }); },
        close() { bunStdin.end(); }, abort() { bunStdin.end(); },
      });

      // 3. Build the Client implementation that handles agent callbacks
      const clientImpl: Client = this.buildClientImpl();

      // 4. Create the ClientSideConnection (TUI = ACP client, child = ACP agent)
      this.conn = new ClientSideConnection((_agent: Agent) => clientImpl, { readable, writable });

      // 5. ACP handshake: initialize (protocolVersion is a number)
      this.emitTransportAuthenticating();
      await this.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-sdk', version: VERSION },
        clientCapabilities: {},
      });

      this.lifetime.signal.throwIfAborted();

      // 6. Create a session (cwd is required, mcpServers is required)
      const sessionResp = await this.conn.newSession({
        cwd: this.task.workingDirectory,
        mcpServers: [],
      });
      this.lifetime.signal.throwIfAborted();
      this.sessionId = sessionResp.sessionId;
      this.emitTransportConnected();
      this.emitTransportSyncing();

      // 7. Send the prompt (uses 'prompt' field with ContentBlock array)
      const promptResp = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [
          {
            type: 'text' as const,
            text: this.buildPromptText(),
          },
        ],
      });

      this.lifetime.signal.throwIfAborted();
      const output = this.lastProgressText || `Completed with stop reason: ${promptResp.stopReason}`;
      const result: SubagentResult = {
        id: this.id,
        success: promptResp.stopReason !== 'cancelled',
        output,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };

      this.info.status = result.success ? 'complete' : 'error';
      if (this.runtimeBus) {
        emitAgentCompleted(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          durationMs: result.duration,
          output: result.output,
          toolCallsMade: result.toolCallsMade,
          usage: mapAcpUsage(promptResp.usage),
        });
      }
      this.emitTransportDisconnected('ACP session completed', false);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(summarizeError(err));
      this.info.status = 'error';
      if (this.runtimeBus) {
        emitAgentFailed(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          error: error.message,
          durationMs: Date.now() - startedAt,
        });
      }
      this.emitTransportTerminalFailure(error.message);
      return {
        id: this.id,
        success: false,
        output: error.message,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };
    } finally {
      this.cleanup();
    }
  }

  /** Cancel the running subagent. */
  async cancel(): Promise<void> {
    this.lifetime.abort();
    this.permissionWire?.close();
    if (this.conn && this.sessionId) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch (err) {
        // If protocol cancel fails, still kill the child process.
        logger.error('AcpConnection.cancel: failed to send cancel to subagent', { id: this.id, err: summarizeError(err) });
      }
    }
    this.info.status = 'cancelled';
    if (this.runtimeBus) {
      emitAgentCancelled(this.runtimeBus, this.emitterContext(), {
        agentId: this.id,
        reason: 'ACP session cancelled',
      });
    }
    this.emitTransportDisconnected('ACP session cancelled', false);
    this.cleanup();
  }

  private emitterContext(): import('../runtime/emitters/index.js').EmitterContext {
    return {
      sessionId: 'acp-connection',
      traceId: `acp-connection:${this.id}`,
      source: 'acp-connection',
    };
  }

  private transportId(): string {
    return `acp:${this.id}`;
  }

  private transportEndpoint(): string {
    return `stdio://subagent/${this.id}`;
  }

  private emitTransportInitializing(): void {
    if (!this.runtimeBus) return;
    emitTransportInitializing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
    void this.fireTransportHook('initializing', {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
  }

  private emitTransportAuthenticating(): void {
    if (!this.runtimeBus) return;
    emitTransportAuthenticating(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('authenticating', {
      transportId: this.transportId(),
    });
  }

  private emitTransportConnected(): void {
    if (!this.runtimeBus) return;
    emitTransportConnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
    void this.fireTransportHook('connected', {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
  }

  private emitTransportSyncing(): void {
    if (!this.runtimeBus) return;
    emitTransportSyncing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('syncing', {
      transportId: this.transportId(),
    });
  }

  private emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportDisconnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
    void this.fireTransportHook('disconnected', {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
  }

  private emitTransportTerminalFailure(error: string): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportTerminalFailure(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      error,
    });
    void this.fireTransportHook('failed', {
      transportId: this.transportId(),
      error,
    });
  }

  private async fireTransportHook(specific: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path: `Lifecycle:transport:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'transport' as HookCategory,
        specific,
        sessionId: 'acp-connection',
        timestamp: Date.now(),
        payload,
      });
    } catch (error) {
      logger.warn('AcpConnection transport hook failed', {
        id: this.id,
        specific,
        error: summarizeError(error),
      });
    }
  }

  private cleanup(): void {
    this.lifetime.abort();
    this.permissionWire?.close();
    try {
      this.childProcess?.kill();
    } catch (err) {
      logger.error('AcpConnection.cleanup: failed to kill child process', { id: this.id, err: summarizeError(err) });
    }
    this.childProcess = null;
    this.conn = null;
    this.sessionId = null;
  }

  private buildClientImpl(): Client {
    return {
      /** A-F1072: same recorded autonomous owner and final wire fence as host ACP. */
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
        let binding: ReturnType<AcpPermissionWire['binding']>;
        let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
        let deferred = false;
        try {
          if (isProxy(params)) return cancelled;
          const call = Object.getOwnPropertyDescriptor(params, 'toolCall')?.value as unknown;
          if (isProxy(call)) return cancelled;
          const id = call && typeof call === 'object' ? Object.getOwnPropertyDescriptor(call, 'toolCallId')?.value as unknown : undefined;
          if (typeof id !== 'string') return cancelled;
          binding = this.permissionWire?.binding(id);
          binding?.bindTerminal(cancelled);
          const owned = binding?.request;
          const protocolSubject = binding?.protocolSubject;
          const host = this.permissionHost, operation = this.operation;
          if (!binding || !owned || !protocolSubject || !host || !operation || !this.sessionId || owned.sessionId !== this.sessionId
            || !owned.toolCall.toolCallId || !Array.isArray(owned.options)
            || owned.options.some((option: AcpPermissionOptionLike) => !option || typeof option.optionId !== 'string' || !option.optionId
              || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
            || new Set(owned.options.map((option: AcpPermissionOptionLike) => option.optionId)).size !== owned.options.length) return cancelled;
          const signal = AbortSignal.any([this.lifetime.signal, binding.signal, AbortSignal.timeout(60_000)]);
          const assertCurrent = () => { signal.throwIfAborted(); binding!.assertCurrent(); operation.assertCurrent(); };
          assertCurrent();
          // Capture the actual originating goal, never the child tool title or generated task prose.
          admission = await admitExternalRequest(host, { connectionId: this.id, destination: this.spawnCmd[0] ?? '', signal, assertCurrent },
            { ...operation, sourceOf: () => { assertCurrent(); return operation.sourceOf(); } }, {
              tool: owned.toolCall.title ?? 'ACP action', protocolSubject,
              args: { ...(owned.toolCall.rawInput && typeof owned.toolCall.rawInput === 'object' && !Array.isArray(owned.toolCall.rawInput)
                ? owned.toolCall.rawInput as Record<string, unknown> : {}), destination: { command: this.spawnCmd, cwd: this.task.workingDirectory } },
            });
          assertCurrent();
          const decision = admission.result.autonomousDecision;
          if (!decision || decision.outcome === 'defer' || decision.outcome === 'revise') return cancelled;
          const response = permissionOutcomeFor(owned.options, { approved: decision.outcome === 'act', remember: false });
          binding.defer(response, admission, decision.outcome === 'act' && response.outcome.outcome === 'selected', () => {});
          deferred = true;
          return response;
        } catch { return cancelled; }
        finally { if (!deferred) admission?.close(); }
      },

      /** Handle session update notifications from the subagent. */
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update;

        // Count tool calls
        if (update.sessionUpdate === 'tool_call') {
          this.toolCallsMade++;
        }

        // Collect streamed text chunks as progress
        if (isMessageChunk(update)) {
          const text = update.content
            ?.filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('') ?? '';
          if (text) {
            this.lastProgressText = (this.lastProgressText + text).slice(-1000);
            this.info.progress = this.lastProgressText.slice(-200);
            if (this.runtimeBus) {
              emitAgentStreamDelta(this.runtimeBus, this.emitterContext(), {
                agentId: this.id,
                content: text,
                accumulated: this.lastProgressText,
              });
            }
          }
        }
      },
    };
  }

  private buildPromptText(): string {
    const parts: string[] = [`Task: ${this.task.description}`];

    if (this.task.context) {
      parts.push(`Context:\n${this.task.context}`);
    }

    if (this.task.tools.length > 0) {
      parts.push(`Available tools: ${this.task.tools.join(', ')}`);
    }

    if (this.task.model) {
      parts.push(`Use model: ${this.task.model}`);
    }

    return parts.join('\n\n');
  }
}
