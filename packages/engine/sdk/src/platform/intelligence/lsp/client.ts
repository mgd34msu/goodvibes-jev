import { logger } from '../../utils/logger.js';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';
import { summarizeError } from '../../utils/error-display.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspNotificationRecord {
  readonly method: string;
  readonly params?: unknown | undefined;
  readonly receivedAt: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_QUEUED_NOTIFICATIONS = 500;

export class LspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private readonly notifications: LspNotificationRecord[] = [];
  /** Raw stdout bytes not yet framed; Content-Length counts bytes, so framing happens before decoding. */
  private buffer: Uint8Array = new Uint8Array(0);
  private readLoopRunning = false;

  constructor(
    private command: string,
    private args: string[],
    private options?: { cwd?: string | undefined; env?: Record<string, string>; timeout?: number },
  ) {}

  /** Start the LSP server process. */
  async start(): Promise<void> {
    if (this.proc) return;
    try {
      this.proc = Bun.spawn([this.command, ...this.args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ...(this.options?.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options?.env !== undefined ? { env: { ...process.env, ...this.options.env } } : {}),
      } as Parameters<typeof Bun.spawn>[1]);
      this._startReadLoop();
    } catch (err) {
      logger.error('LspClient: failed to start process', { command: this.command, err: summarizeError(err) });
      this.proc = null;
      throw err;
    }
  }

  /** Send a request and wait for response. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || !this.isRunning) {
      throw new Error('LspClient: server is not running');
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const json = JSON.stringify(msg);
    const frame = LspClient.encodeFrame(json);

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options?.timeout ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LspClient: request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        (this.proc?.stdin as import('bun').FileSink | undefined)?.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`LspClient: failed to write request: ${summarizeError(err)}`));
      }
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isRunning) return;
    try {
      const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      const json = JSON.stringify(msg);
      const frame = LspClient.encodeFrame(json);
      (this.proc.stdin as import('bun').FileSink).write(frame);
    } catch (err) {
      logger.error('LspClient: failed to send notification', { method, err: summarizeError(err) });
    }
  }

  takeNotifications(predicate: (notification: LspNotificationRecord) => boolean): LspNotificationRecord[] {
    const taken: LspNotificationRecord[] = [];
    const retained: LspNotificationRecord[] = [];
    for (const notification of this.notifications) {
      if (predicate(notification)) {
        taken.push(notification);
      } else {
        retained.push(notification);
      }
    }
    this.notifications.length = 0;
    this.notifications.push(...retained);
    return taken;
  }

  /** Stop the server process. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('LspClient: server stopped'));
      this.pendingRequests.delete(id);
    }
    try {
      (this.proc.stdin as import('bun').FileSink).end();
      this.proc.kill();
      await this.proc.exited;
    } catch (err) {
      logger.warn('LspClient: shutdown cleanup failed', { err: summarizeError(err) });
    } finally {
      this.proc = null;
      this.buffer = new Uint8Array(0);
      this.notifications.length = 0;
      this.readLoopRunning = false;
    }
  }

  /** Is the server running? */
  get isRunning(): boolean {
    if (!this.proc) return false;
    // Bun.spawn process: check exitCode, null means still running
    try {
      return (this.proc as { exitCode: number | null }).exitCode === null;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _startReadLoop(): void {
    if (this.readLoopRunning || !this.proc) return;
    this.readLoopRunning = true;

    const proc = this.proc;

    (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer = concatBytes(this.buffer, value);
          this._processBuffer();
        }
      } catch (err) {
        logger.warn('LspClient: stdout read loop failed', { err: summarizeError(err) });
      } finally {
        this.readLoopRunning = false;
        // Reject any remaining pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('LspClient: server process exited unexpectedly'));
          this.pendingRequests.delete(id);
        }
      }
    })();
  }

  private _processBuffer(): void {
    const { bodies, rest } = takeFrames(this.buffer);
    this.buffer = rest;
    for (const body of bodies) this._dispatchMessage(body);
  }

  private _dispatchMessage(body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      logger.error('LspClient: failed to parse JSON-RPC message', { err: summarizeError(err), body: body.slice(0, 200) });
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      logger.warn('LspClient: received malformed JSON-RPC payload', { payloadType: typeof msg });
      return;
    }

    const response = msg as JsonRpcResponse;
    if ('id' in response && typeof response.id === 'number') {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`LSP error ${response.error.code}: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      } else {
        logger.warn('LspClient: received response for unknown request id', { id: response.id });
      }
      return;
    }

    const notification = msg as JsonRpcNotification;
    if (notification.jsonrpc === '2.0' && typeof notification.method === 'string') {
      if (this.notifications.length >= MAX_QUEUED_NOTIFICATIONS) {
        const evicted = this.notifications.shift();
        logger.warn('LspClient: evicted queued notification after capacity limit', {
          evictedMethod: evicted?.method,
          capacity: MAX_QUEUED_NOTIFICATIONS,
        });
      }
      this.notifications.push({
        method: notification.method,
        ...(notification.params !== undefined ? { params: notification.params } : {}),
        receivedAt: Date.now(),
      });
      logger.debug('LspClient: received notification', { method: notification.method });
      return;
    }

    logger.warn('LspClient: received unrecognized JSON-RPC message', { message: msg });
  }

  /** Encode a JSON-RPC frame (Content-Length framing). Exposed for testing. */
  static encodeFrame(json: string): string {
    const bytes = Buffer.byteLength(json, 'utf-8');
    return `Content-Length: ${bytes}\r\n\r\n${json}`;
  }

  /** Parse all complete JSON-RPC messages from a buffer string. Returns [messages, remainingBuffer]. */
  static parseMessages(buffer: string): [unknown[], string] {
    const { bodies, rest } = takeFrames(new TextEncoder().encode(buffer));
    const messages: unknown[] = [];
    for (const body of bodies) {
      try {
        messages.push(JSON.parse(body));
      } catch {
        // skip malformed
      }
    }
    return [messages, new TextDecoder().decode(rest)];
  }
}

const HEADER_TERMINATOR = [13, 10, 13, 10];

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function indexOfTerminator(bytes: Uint8Array): number {
  outer: for (let index = 0; index + HEADER_TERMINATOR.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < HEADER_TERMINATOR.length; offset += 1) {
      if (bytes[index + offset] !== HEADER_TERMINATOR[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/**
 * Splits complete Content-Length frames off the front of a byte buffer. The
 * length is a byte count (LSP base protocol), so the body is cut from the raw
 * bytes and only then decoded as UTF-8; a body with multi-byte characters is
 * cut exactly where the header says.
 */
function takeFrames(buffer: Uint8Array): { bodies: string[]; rest: Uint8Array } {
  const decoder = new TextDecoder();
  const bodies: string[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = indexOfTerminator(rest);
    if (headerEnd === -1) break;
    const header = decoder.decode(rest.subarray(0, headerEnd));
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    const bodyStart = headerEnd + HEADER_TERMINATOR.length;
    if (!contentLengthMatch) {
      // Malformed header, skip to the next boundary.
      rest = rest.subarray(bodyStart);
      continue;
    }
    const bodyEnd = bodyStart + parseInt(contentLengthMatch[1]!, 10);
    if (rest.length < bodyEnd) break;
    bodies.push(decoder.decode(rest.subarray(bodyStart, bodyEnd)));
    rest = rest.subarray(bodyEnd);
  }
  return { bodies, rest: rest.slice() };
}
