import { prepareExternalExecution } from '../permissions/external-execution.js';
import { captureAcpPermissionRequest, readProtocolRequest, type CapturedProtocolRequest } from '../permissions/protocol-request.js';
import { AcpPermissionWire } from './permission-wire.js';
/**
 * acp/host.ts, HOSTING third-party coding agents over the Agent Client
 * Protocol.
 *
 * The existing acp/ modules make GoodVibes an ACP *agent* (agent.ts) and spawn
 * short-lived ACP *subagents* (connection.ts/manager.ts). This module is the
 * daemon-side HOST: it discovers installed third-party coding agents (Claude
 * Code, Codex CLI, opencode), spawns one over stdio as a LONG-LIVED session,
 * and exposes the lifecycle a fleet row needs, prompt (steer), stop, and the
 * waiting-on-human attention states, so a hosted agent is visible, steerable,
 * and stoppable exactly like a native row.
 *
 * Honesty contract:
 *  - Discovery is READ-ONLY (PATH + known install directories; no execution).
 *    Absence is quiet, an empty list, never a nag.
 *  - A binary that fails the ACP handshake yields a STRUCTURED error (which
 *    binary, which stage, what happened) on a 'failed' record, never a hung
 *    row. Spawn/initialize/session are bounded by a handshake timeout.
 *  - Permission requests use the canonical recorded autonomous admission
 *    against the current host prompt, policy, session and exact request. No
 *    human approval callback is used; unavailable authority cancels the ask.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
// `@agentclientprotocol/sdk` is an optionalDependency. This module is on the
// daemon's graph, so a static import of its values made an absent optional
// package a daemon that does not exist; the values come off the awaited module
// in acp/optional-sdk.ts at connection time instead. The type import is erased.
import { loadAcpSdk } from './optional-sdk.js';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { Agent, Client, NewSessionResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from './protocol.js';
import { permissionOutcomeFor, type AcpPermissionOptionLike } from './protocol.js';
import type { PermissionRequestHandler } from '../permissions/prompt.js';
import { admitExternalRequest, type ExternalPermissionHost } from '../permissions/external-request.js';
import { captureAutonomousSource, type AutonomousToolSource } from '../permissions/autonomous.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { VERSION } from '../version.js';

// ── Discovery ────────────────────────────────────────────────────────────────

/** One known third-party ACP-capable coding agent and how to launch its ACP mode. */
export interface KnownAcpAgent {
  readonly id: string;
  readonly title: string;
  /** Launch candidates, first found wins: binary name + the args that start ACP stdio mode. */
  readonly candidates: ReadonlyArray<{ readonly binary: string; readonly args: readonly string[] }>;
}

/**
 * The known agents table. The ACP launch shape per agent:
 *  - Claude Code speaks ACP through its dedicated adapter binary
 *    (`claude-code-acp`, the officially published bridge). The bare `claude`
 *    binary is deliberately NOT a candidate: it has no ACP mode (verified
 *    live), and advertising it would offer a spawn that always fails.
 *  - Codex CLI exposes `codex acp` (experimental) on recent builds.
 *  - opencode serves ACP via `opencode acp` (verified live end-to-end).
 * A wrong/outdated launch shape is not a hazard: the handshake timeout turns
 * it into a structured 'failed' record, never a hung row.
 */
export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  { id: 'claude-code', title: 'Claude Code', candidates: [{ binary: 'claude-code-acp', args: [] }] },
  { id: 'codex', title: 'Codex CLI', candidates: [{ binary: 'codex', args: ['acp'] }] },
  { id: 'opencode', title: 'opencode', candidates: [{ binary: 'opencode', args: ['acp'] }] },
];

/** A discovered, spawnable third-party agent: which binary resolved and how to launch it. */
export interface DiscoveredAcpAgent {
  readonly id: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly args: readonly string[];
}

/** Injectable probes so discovery is testable without touching the real filesystem. */
export interface DiscoveryIo {
  readonly fileExists: (path: string) => boolean;
  readonly envPath: () => string;
  readonly home: () => string;
}

const defaultDiscoveryIo: DiscoveryIo = {
  fileExists: (path) => existsSync(path),
  envPath: () => process.env.PATH ?? '',
  home: () => homedir(),
};

/** Known install directories checked IN ADDITION to $PATH (read-only). */
function knownInstallDirs(io: DiscoveryIo): string[] {
  const home = io.home();
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/**
 * Discover installed third-party ACP-capable agents. READ-ONLY: existence
 * checks over $PATH entries and known install directories, no process is ever
 * executed. Returns only what is present; absence is a quiet empty list.
 */
export function discoverAcpAgents(io: DiscoveryIo = defaultDiscoveryIo): DiscoveredAcpAgent[] {
  const dirs = [...io.envPath().split(delimiter).filter(Boolean), ...knownInstallDirs(io)];
  const seen = new Set<string>();
  const uniqueDirs = dirs.filter((dir) => (seen.has(dir) ? false : (seen.add(dir), true)));
  const found: DiscoveredAcpAgent[] = [];
  for (const agent of KNOWN_ACP_AGENTS) {
    for (const candidate of agent.candidates) {
      const dir = uniqueDirs.find((d) => io.fileExists(join(d, candidate.binary)));
      if (dir) {
        found.push({ id: agent.id, title: agent.title, binaryPath: join(dir, candidate.binary), args: candidate.args });
        break; // first candidate wins per agent
      }
    }
  }
  return found;
}

// ── Hosted sessions ──────────────────────────────────────────────────────────

/** Lifecycle state of a hosted third-party agent session. */
export type HostedAcpState = 'starting' | 'idle' | 'prompting' | 'awaiting-approval' | 'failed' | 'stopped';

/** The structured, user-renderable handshake/spawn failure, never a bare string. */
export interface AcpHostError {
  /** The binary that was launched. */
  readonly binary: string;
  /** Which stage failed: spawning the process, the ACP initialize, or session creation. */
  readonly stage: 'spawn' | 'initialize' | 'session' | 'prompt';
  readonly message: string;
}

/** One hosted third-party agent session, as the fleet adapter reads it. */
export interface HostedAcpAgent {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly state: HostedAcpState;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  /** The daemon shared-session id this hosted agent is mapped onto. */
  readonly sessionId?: string | undefined;
  /** Latest streamed output tail (bounded), for the row's activity line. */
  readonly progress?: string | undefined;
  /** Present while a permission ask is pending, the attention detail. */
  readonly pendingPermission?: string | undefined;
  /** Present when state === 'failed'. */
  readonly error?: AcpHostError | undefined;
  readonly promptCount: number;
}

interface HostedRecord {
  info: {
    id: string; agentId: string; title: string; binaryPath: string; cwd: string;
    state: HostedAcpState; startedAt: number; completedAt?: number | undefined;
    sessionId?: string | undefined; progress?: string | undefined;
    pendingPermission?: string | undefined; error?: AcpHostError | undefined; promptCount: number;
  };
  child: ReturnType<typeof Bun.spawn> | null;
  conn: ClientSideConnection | null;
  acpSessionId: string | null;
  lifetime: AbortController;
  operation?: { readonly source: AutonomousToolSource; readonly lifetime: AbortController } | undefined;
  readonly permissionRequests: Map<string, AbortController>;
  permissionWire?: AcpPermissionWire | undefined;
  assertWorkspaceCurrent?: (() => void) | undefined;
  teardownPromise?: Promise<void> | undefined;
  teardownState?: 'pending' | 'done' | 'failed' | undefined;

}

/** Registers/heartbeats the daemon shared session a hosted agent maps onto. */
export type AcpSessionRegistrar = (input: {
  readonly id: string;
  readonly title: string;
  readonly agentTitle: string;
  readonly cwd: string;
}) => void;

export interface AcpHostServiceDeps {
  /** Canonical recorded autonomous owner. No configured owner means fail closed. */
  readonly permissionHost?: ExternalPermissionHost | undefined;
  /** @deprecated Human callbacks are not used by the autonomous ACP host. */
  readonly requestPermission?: PermissionRequestHandler | undefined;
  /** Maps the hosted agent onto a daemon shared session (kind 'acp'). Optional, narrower embeds skip it. */
  readonly registerSession?: AcpSessionRegistrar | undefined;
  /** Injectable spawn seam for tests. Defaults to Bun.spawn. */
  readonly spawn?: ((cmd: string[], opts: { cwd: string }) => ReturnType<typeof Bun.spawn>) | undefined;
  /** Handshake bound (spawn→initialize→session). Default 15s, a bad binary becomes a structured failure, never a hung row. */
  readonly handshakeTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const PROGRESS_TAIL_CHARS = 400;
const SHUTDOWN_GRACE_MS = 250;
const FORCED_EXIT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

export class AcpHostService {
  private readonly records = new Map<string, HostedRecord>();
  private readonly deps: AcpHostServiceDeps;
  private readonly now: () => number;

  constructor(deps: AcpHostServiceDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  list(): HostedAcpAgent[] {
    return [...this.records.values()].map((record) => ({ ...record.info }));
  }

  get(id: string): HostedAcpAgent | null {
    const record = this.records.get(id);
    return record ? { ...record.info } : null;
  }

  /**
   * Spawn a discovered agent into a working directory as a hosted session.
   * Resolves once the ACP handshake + session creation completed (state
   * 'idle', ready for prompts) or failed (state 'failed' with the structured
   * error). An initial prompt, when given, is fired after the handshake
   * without being awaited, the row streams like any live agent.
   */
  async spawnAgent(input: {
    readonly agent: DiscoveredAcpAgent;
    readonly cwd: string;
    readonly title?: string | undefined;
    readonly prompt?: string | undefined;
  }): Promise<HostedAcpAgent> {
    input = structuredClone(input);
    const host = this.deps.permissionHost;
    host?.signal.throwIfAborted();
    const configuration = new AbortController();
    const unsubscribe = host?.config.onDidInvalidate(() => configuration.abort()) ?? (() => {});
    const signal = AbortSignal.any([configuration.signal, ...(host ? [host.signal] : [])]);
    let assertWorkspaceCurrent: (() => void) | undefined;
    try { assertWorkspaceCurrent = host ? await prepareExternalExecution(host, input.cwd, signal) : undefined; }
    catch (error) { unsubscribe(); throw error; }
    const assertSpawnCurrent = () => {
      signal.throwIfAborted(); assertWorkspaceCurrent?.();
      if (this.deps.permissionHost !== host) throw new Error('ACP spawn owner changed');
    };
    const id = `acp-host-${randomUUID().slice(0, 10)}`;
    const sessionId = `acp-${id}`;
    const record: HostedRecord = {
      info: {
        id,
        agentId: input.agent.id,
        title: input.title ?? `${input.agent.title}: ${input.cwd}`,
        binaryPath: input.agent.binaryPath,
        cwd: input.cwd,
        state: 'starting',
        startedAt: this.now(),
        promptCount: 0,
      },
      child: null,
      conn: null,
      acpSessionId: null,
      lifetime: new AbortController(),
      permissionRequests: new Map(),
      assertWorkspaceCurrent,
    };
    this.records.set(id, record);
    const timeoutMs = this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const spawn = this.deps.spawn ?? ((cmd: string[], opts: { cwd: string }) => Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));

    let stage: AcpHostError['stage'] = 'spawn';
    try {
      // Inside the try, so an install without the optional ACP package fails
      // this one session start with a message naming it, reported through the
      // same AcpHostError path as a spawn failure.
      const { ClientSideConnection, ndJsonStream } = await loadAcpSdk();
      record.lifetime.signal.throwIfAborted();
      this.deps.permissionHost?.signal.throwIfAborted();
      assertSpawnCurrent();
      record.child = spawn([input.agent.binaryPath, ...input.agent.args], { cwd: input.cwd });
      const ownedChild = record.child;
      void ownedChild.exited.then(() => {
        if (record.child !== ownedChild || record.lifetime.signal.aborted) return;
        record.info.state = 'failed'; record.info.completedAt = this.now();
        record.info.error = { binary: record.info.binaryPath, stage: 'prompt', message: 'Hosted ACP process exited' };
        this.teardown(record);
      }, () => { if (record.child === ownedChild) this.teardown(record); });
      if (!record.child.stdin || !record.child.stdout) {
        throw new Error('subprocess stdio not available (stdin/stdout must be piped)');
      }
      const bunStdin = record.child.stdin as import('bun').FileSink;
      record.permissionWire = new AcpPermissionWire(() => {
        const operation = record.operation, sessionId = record.acpSessionId;
        const invalidation = new AbortController();
        const unsubscribe = this.deps.permissionHost?.config.onDidInvalidate(() => invalidation.abort()) ?? (() => {});
        const assertCurrent = () => {
          invalidation.signal.throwIfAborted(); record.lifetime.signal.throwIfAborted(); record.assertWorkspaceCurrent?.();
          operation?.lifetime.signal.throwIfAborted(); this.deps.permissionHost?.signal.throwIfAborted();
          if (!operation || !sessionId || record.operation !== operation || record.acpSessionId !== sessionId || record.child !== ownedChild)
            throw new Error('ACP permission response owner changed');
        };
        return { assertCurrent, close: unsubscribe };
      });
      const stdinStream = new WritableStream<Uint8Array>({
        write(chunk) { bunStdin.write(chunk); },
        close() { bunStdin.end(); },
        abort() { bunStdin.end(); },
      });
      const stream = ndJsonStream(stdinStream, record.child.stdout as unknown as ReadableStream<Uint8Array>);
      type WireMessage = typeof stream.readable extends ReadableStream<infer Message> ? Message : never;
      const readable = stream.readable.pipeThrough(new TransformStream<WireMessage, WireMessage>({ transform(message, controller) {
        record.permissionWire!.observe(message); controller.enqueue(message);
      } }));
      // Own the final message sink rather than relying on the SDK's async
      // serializer: its queued write could otherwise outlive an act decision.
      const writable = new WritableStream<WireMessage>({
        write(message) { record.permissionWire!.write(message, bytes => { bunStdin.write(bytes); }); },
        close() { bunStdin.end(); }, abort() { bunStdin.end(); },
      });
      record.conn = new ClientSideConnection((_agent: Agent) => this.buildClient(record), { readable, writable });

      stage = 'initialize';
      await withTimeout(record.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-daemon', version: VERSION },
        clientCapabilities: {},
      }), timeoutMs, 'ACP initialize');

      record.lifetime.signal.throwIfAborted();
      this.deps.permissionHost?.signal.throwIfAborted();
      assertSpawnCurrent();
      stage = 'session';
      const session = await withTimeout<NewSessionResponse>(record.conn.newSession({ cwd: input.cwd, mcpServers: [] }), timeoutMs, 'ACP session/new');
      record.lifetime.signal.throwIfAborted();
      this.deps.permissionHost?.signal.throwIfAborted();
      assertSpawnCurrent();
      record.acpSessionId = session.sessionId;

      record.info.sessionId = sessionId;
      record.info.state = 'idle';
      try {
        this.deps.registerSession?.({ id: sessionId, title: record.info.title, agentTitle: input.agent.title, cwd: input.cwd });
      } catch (error) {
        logger.warn('AcpHostService: shared-session registration failed', { id, error: summarizeError(error) });
      }
      if (input.prompt) void this.prompt(id, input.prompt);
      return { ...record.info };
    } catch (error) {
      if (record.info.state === 'stopped') { await this.teardown(record); return { ...record.info }; }
      record.info.state = 'failed';
      record.info.completedAt = this.now();
      record.info.error = {
        binary: input.agent.binaryPath,
        stage,
        message: summarizeError(error),
      };
      await this.teardown(record);
      return { ...record.info };
    } finally { unsubscribe(); }
  }

  /**
   * Send a prompt (a steer) to a hosted agent's live ACP session. Honest
   * refusal for a row that cannot take one. Resolves queued immediately; the
   * turn streams in the background and the state returns to 'idle' when the
   * agent's turn ends.
   */
  prompt(id: string, text: string): { queued: true } | { queued: false; reason: string } {
    if (this.deps.permissionHost?.signal.aborted) return { queued: false, reason: 'hosted agent owner is closed' };
    const record = this.records.get(id);
    if (!record) return { queued: false, reason: 'no such hosted agent' };
    try { record.assertWorkspaceCurrent?.(); } catch (error) { return { queued: false, reason: summarizeError(error) }; }
    if (!record.conn || !record.acpSessionId) return { queued: false, reason: 'hosted agent has no live ACP session' };
    if (record.info.state === 'failed' || record.info.state === 'stopped') {
      return { queued: false, reason: `hosted agent is ${record.info.state}` };
    }
    // ACP permission requests identify the session, not their originating prompt.
    // Two overlapping prompts would let a late ask borrow the newer goal.
    if (record.operation && !record.operation.lifetime.signal.aborted) return { queued: false, reason: 'hosted agent already has an active prompt' };
    const operation = { source: captureAutonomousSource({ goal: text, criteria: [] }), lifetime: new AbortController() };
    record.operation = operation;
    record.info.state = 'prompting';
    record.info.promptCount += 1;
    const conn = record.conn;
    const sessionId = record.acpSessionId;
    void conn.prompt({ sessionId, prompt: [{ type: 'text' as const, text }] })
      .then((response: PromptResponse) => {
        if (record.operation !== operation) return;
        operation.lifetime.abort();
        if (record.info.state === 'prompting' || record.info.state === 'awaiting-approval') {
          record.info.state = response.stopReason === 'cancelled' ? 'stopped' : 'idle';
          if (record.info.state === 'stopped') record.info.completedAt = this.now();
        }
      })
      .catch((error: unknown) => {
        if (record.operation !== operation) return;
        operation.lifetime.abort();
        if (record.info.state === 'stopped') return; // stop() raced the in-flight turn, not a failure
        record.info.state = 'failed';
        record.info.completedAt = this.now();
        record.info.error = { binary: record.info.binaryPath, stage: 'prompt', message: summarizeError(error) };
        this.teardown(record);
      });
    return { queued: true };
  }

  /** Stop a hosted agent and await its single owned child-drain promise. */
  async stop(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    const wasRunning = record.info.state !== 'stopped' && record.info.state !== 'failed';
    const connection = record.conn, sessionId = record.acpSessionId;
    if (wasRunning) {
      record.info.state = 'stopped';
      record.info.completedAt = this.now();
      record.info.pendingPermission = undefined;
    }
    await this.teardown(record, wasRunning && connection && sessionId
      ? () => connection.cancel({ sessionId }) : undefined);
    return wasRunning;
  }

  /** Drop terminal records (a panel dismiss); live rows are untouched. */
  dismiss(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.info.state !== 'stopped' && record.info.state !== 'failed') return false;
    // A dismissed row must not orphan a still-running or failed-cleanup child.
    if (record.child || record.teardownState === 'pending' || record.teardownState === 'failed') return false;
    this.records.delete(id);
    return true;
  }

  private teardown(record: HostedRecord, cancel?: () => Promise<void>): Promise<void> {
    if (record.teardownPromise) return record.teardownPromise;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const owned = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    // Publish ownership before abort/unsubscribe callbacks can reenter stop.
    record.teardownPromise = owned;
    record.teardownState = 'pending';
    const child = record.child;
    record.conn = null;
    record.acpSessionId = null;
    const cleanupErrors: unknown[] = [];
    // Every authority is revoked synchronously, before any unrelated drain.
    record.lifetime.abort();
    record.operation?.lifetime.abort();
    try { record.permissionWire?.close(); } catch (error) { cleanupErrors.push(error); }
    const draining = Promise.resolve().then(async () => {
      if (cancel) {
        try { await withTimeout(cancel(), SHUTDOWN_GRACE_MS, 'ACP cancel'); }
        catch (error) { logger.warn('AcpHostService: cancel failed; terminating child', { id: record.info.id, error: summarizeError(error) }); }
      }
      if (!child) {
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Hosted ACP permission cleanup failed');
        return;
      }
      try { child.kill('SIGTERM'); }
      catch (error) { logger.warn('AcpHostService: graceful child termination failed', { id: record.info.id, error: summarizeError(error) }); }
      try { await withTimeout(child.exited, SHUTDOWN_GRACE_MS, 'ACP graceful child exit'); }
      catch (graceError) {
        try { child.kill('SIGKILL'); }
        catch (error) { logger.warn('AcpHostService: forced child termination failed', { id: record.info.id, error: summarizeError(error) }); }
        try { await withTimeout(child.exited, FORCED_EXIT_TIMEOUT_MS, 'ACP forced child exit'); }
        catch (error) { throw new AggregateError([...cleanupErrors, graceError, error], 'Hosted ACP child cleanup failed'); }
      }
      // Retain the child on cleanup failure so dismissal cannot erase ownership.
      if (record.child === child) record.child = null;
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Hosted ACP permission cleanup failed');
    });
    void draining.then(() => { record.teardownState = 'done'; complete(); }, error => { record.teardownState = 'failed'; fail(error); });
    // Prompt/exit callbacks initiate the same promise; stop and outer shutdown
    // still await and report its original failure.
    void owned.catch(error => logger.warn('AcpHostService: child drainage failed', { id: record.info.id, error: summarizeError(error) }));
    return owned;
  }

  private buildClient(record: HostedRecord): Client {
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
        let wireBinding: ReturnType<AcpPermissionWire['binding']>;
        if (record.permissionWire) {
          // Descriptor reads preserve cancellation identity even when protected
          // payloads fail the privacy snapshot. No remote getter is invoked.
          try {
            const call = Object.getOwnPropertyDescriptor(params, 'toolCall')?.value as unknown;
            const id = call && typeof call === 'object' ? Object.getOwnPropertyDescriptor(call, 'toolCallId')?.value as unknown : undefined;
            if (typeof id === 'string') wireBinding = record.permissionWire.binding(id);
            wireBinding?.bindTerminal(cancelled);
          } catch { return cancelled; }
        }
        const host = this.deps.permissionHost;
        const operation = record.operation;
        if (!host || !operation || record.lifetime.signal.aborted) return cancelled;
        let owned: RequestPermissionRequest;
        let protocolSubject: CapturedProtocolRequest;
        try { protocolSubject = captureAcpPermissionRequest(params); owned = readProtocolRequest(protocolSubject).wire as RequestPermissionRequest; } catch { return cancelled; }
        const sessionId = record.acpSessionId;
        const connection = record.conn;
        const requestId = owned.toolCall?.toolCallId;
        if (record.permissionWire) {
          try {
            if (!wireBinding?.request) return cancelled;
            wireBinding.assertCurrent(); owned = wireBinding.request;
            if (!wireBinding.protocolSubject) return cancelled; protocolSubject = wireBinding.protocolSubject;
          } catch { return cancelled; }
        }
        if (!sessionId || !connection || owned.sessionId !== sessionId || typeof requestId !== 'string' || !requestId || !Array.isArray(owned.options)
          || owned.options.some((option: AcpPermissionOptionLike) => !option || typeof option.optionId !== 'string' || !option.optionId
            || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
          || new Set(owned.options.map((option: AcpPermissionOptionLike) => option.optionId)).size !== owned.options.length) return cancelled;
        const previous = record.permissionRequests.get(requestId);
        if (previous) { previous.abort(); return cancelled; }
        const requestLife = new AbortController();
        record.permissionRequests.set(requestId, requestLife);
        const signal = AbortSignal.any([record.lifetime.signal, operation.lifetime.signal, requestLife.signal, AbortSignal.timeout(60_000), ...(wireBinding ? [wireBinding.signal] : [])]);
        const assertCurrent = () => {
          signal.throwIfAborted(); wireBinding?.assertCurrent(); record.assertWorkspaceCurrent?.();
          if (this.records.get(record.info.id) !== record || record.conn !== connection || record.acpSessionId !== sessionId
            || record.operation !== operation || record.permissionRequests.get(requestId) !== requestLife) throw new Error('ACP request is no longer current');
        };
        let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
        let deferred = false;
        const cleanup = () => {
          if (record.permissionRequests.get(requestId) === requestLife) record.permissionRequests.delete(requestId);
          requestLife.abort();
        };
        try {
          admission = await admitExternalRequest(host, { connectionId: record.info.id, destination: record.info.binaryPath, signal, assertCurrent },
            { sourceOf: () => operation.source, assertCurrent, signal }, {
              tool: owned.toolCall.title ?? 'ACP action', protocolSubject,
              args: { ...(owned.toolCall.rawInput && typeof owned.toolCall.rawInput === 'object' && !Array.isArray(owned.toolCall.rawInput)
                ? owned.toolCall.rawInput as Record<string, unknown> : {}),
                destination: { binaryPath: record.info.binaryPath, cwd: record.info.cwd } },
            });
          assertCurrent();
          const decision = admission.result.autonomousDecision;
          if (!decision || decision.outcome === 'defer' || decision.outcome === 'revise') return cancelled;
          const response = permissionOutcomeFor(owned.options, { approved: decision.outcome === 'act', remember: false });
          const claim = decision.outcome === 'act' && response.outcome.outcome === 'selected';
          if (wireBinding) {
            wireBinding.defer(response, admission, claim, cleanup); deferred = true;
          } else if (claim) admission.claim();
          assertCurrent();
          return response;
        } catch { return cancelled; }
        finally {
          if (!deferred) { admission?.close(); cleanup(); }
        }
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update as { sessionUpdate?: unknown; content?: unknown };
        if (update.sessionUpdate !== 'agent_message_chunk') return;
        // ACP sends `content` as ONE ContentBlock; tolerate the array shape too.
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        const text = blocks
          .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (text) {
          record.info.progress = ((record.info.progress ?? '') + text).slice(-PROGRESS_TAIL_CHARS);
        }
      },
    };
  }
}
