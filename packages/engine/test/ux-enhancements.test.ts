/**
 * Tests for UX-first enhancements:
 *  Typed connection-state events (ConnectionState, ReconnectAttemptInfo)
 *  Backpressure visibility (BackpressureInfo, onBackpressure callback)
 *  WS error envelope parity (createWebSocketRemoteError)
 *  Granular progress event contracts (BATCH_JOB_PROGRESS, EXPORT_PROGRESS, KNOWLEDGE_INGEST_PROGRESS)
 */
import { describe, expect, test } from 'bun:test';
import {
  createWebSocketConnector,
  createWebSocketRemoteError,
  WebSocketTransportError,
  type BackpressureInfo,
  type ConnectionState,
  type ConnectorTransportEvent,
  type ReconnectAttemptInfo,
  type RuntimeEventConnectorOptions,
} from '../sdk/dist/index.js';
import type {
  TaskEvent,
  KnowledgeEvent,
  TransportEvent,
} from '../sdk/dist/index.js';
import { WebSocketMessageAssembler } from '../transport-core/src/websocket-messages.ts';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// Minimal mock WebSocket for connector tests
// ---------------------------------------------------------------------------
type WsEventName = 'open' | 'message' | 'close' | 'error';

interface MockWebSocketHandle {
  simulateOpen(): void;
  simulateMessage(data: string): void;
  simulateClose(code?: number, reason?: string): void;
  sentMessages: string[];
}

function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket;
  instances: MockWebSocketHandle[];
} {
  const instances: MockWebSocketHandle[] = [];

  class MockWebSocket {
    private listeners = new Map<WsEventName, Set<EventListenerOrEventListenerObject>>();
    readonly sentMessages: string[] = [];
    readonly url: string;
    readyState: number = 0;

    constructor(url: string) {
      this.url = url;
      const handle: MockWebSocketHandle = {
        simulateOpen: () => {
          this.readyState = 1;
          this._dispatch('open', new Event('open'));
        },
        simulateMessage: (data: string) => {
          const evt = new MessageEvent('message', { data });
          this._dispatch('message', evt);
        },
        simulateClose: (code = 1006, reason = '') => {
          this.readyState = 3;
          const evt = new CloseEvent('close', { code, reason, wasClean: code === 1000 });
          this._dispatch('close', evt);
        },
        sentMessages: this.sentMessages,
      };
      instances.push(handle);
    }

    static get OPEN(): number { return 1; }

    addEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }

    removeEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      this.listeners.get(event)?.delete(listener);
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close() { this.readyState = 3; }

    private _dispatch(event: WsEventName, evt: Event) {
      for (const listener of this.listeners.get(event) ?? []) {
        if (typeof listener === 'function') listener(evt);
        else listener.handleEvent(evt);
      }
    }
  }

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances };
}

/** Asserts at least one mock socket was created and returns the first one, narrowed. */
function firstInstance(instances: MockWebSocketHandle[]): MockWebSocketHandle {
  expect(instances.length).toBeGreaterThanOrEqual(1);
  return instances[0]!;
}

/**
 * DomainEventConnector's declared return type is `void | Promise<() => void>`,
 * the WebSocket branch always resolves a real stop function, but the type
 * doesn't promise that. Assert it before calling, so a real regression (the
 * connector silently returning nothing) fails loudly instead of leaking an
 * open socket across tests.
 */
function stopOrThrow(stop: (() => void) | void): void {
  if (typeof stop !== 'function') throw new Error('connector did not return a stop function');
  stop();
}

// ---------------------------------------------------------------------------
// Typed connection-state events
// ---------------------------------------------------------------------------
describe('typed connection-state events', () => {
  test('ConnectionState type is exported and covers all expected literals', () => {
    // Type-level assertion: if any literal is missing this assignment would fail at compile time.
    const states: ConnectionState[] = [
      'connecting',
      'connected',
      'reconnecting',
      'disconnected',
      'failed',
    ];
    expect(states).toHaveLength(5);
  });

  test('ReconnectAttemptInfo type carries all required fields', () => {
    const info: ReconnectAttemptInfo = {
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: 'connection closed',
    };
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(10);
    expect(info.delayMs).toBe(500);
    expect(info.reason).toBe('connection closed');
  });

  test('onConnectionStateChange fires connecting then connected on successful open', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});
    expect(instances).toHaveLength(1);

    firstInstance(instances).simulateOpen();
    await settleEvents(10);

    // Exact sequence: connecting (from connect()) then connected (after auth).
    // onOpen must NOT emit 'connecting', that would be a dedup-suppressed no-op
    // but semantically wrong. The sequence must be exactly [connecting, connected].
    expect(states).toEqual(['connecting', 'connected']);

    stopOrThrow(stop);
    await settleEvents(0);
    expect(states).toContain('disconnected');
  });

  test('onConnectionStateChange fires reconnecting after abnormal close', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateClose(1006); // abnormal close
    await settleEvents(10);

    expect(states).toContain('reconnecting');
    stopOrThrow(stop);
  });

  test('onConnectionStateChange fires failed when attempts exhausted', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // exhaust the single allowed reconnect
    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateClose(1006);
    await settleEvents(10);
    // second connection attempt (reconnect #1)
    const ws2 = instances[instances.length - 1];
    if (ws2) {
      ws2.simulateOpen();
      await settleEvents(10);
      ws2.simulateClose(1006);
      await settleEvents(10);
    }

    expect(states).toContain('failed');
    stopOrThrow(stop);
  });

  test('onReconnectAttempt fires with structured metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const attempts: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onReconnectAttempt: (info) => attempts.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateClose(1006, 'server error');
    await settleEvents(10);

    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const first = attempts[0]!;
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(5);
    expect(typeof first.delayMs).toBe('number');
    expect(typeof first.reason).toBe('string');
    expect(first.reason.length).toBeGreaterThan(0);

    stopOrThrow(stop);
  });

  test('legacy onReconnect still fires alongside onReconnectAttempt (backward compat)', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const legacyCalls: [number, number][] = [];
    const newCalls: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onReconnect: (attempt, delayMs) => legacyCalls.push([attempt, delayMs]),
      onReconnectAttempt: (info) => newCalls.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateClose(1006);
    await settleEvents(10);

    expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
    expect(newCalls.length).toBeGreaterThanOrEqual(1);
    // Both should agree on attempt number
    expect(legacyCalls[0]![0]).toBe(newCalls[0]!.attempt);

    stopOrThrow(stop);
  });
});

// ---------------------------------------------------------------------------
// Backpressure visibility
// ---------------------------------------------------------------------------
describe('backpressure visibility', () => {
  test('BackpressureInfo type carries all required fields', () => {
    const info: BackpressureInfo = {
      droppedCount: 5,
      queueLength: 100,
      queueBytes: 102400,
      reason: 'queue_full',
    };
    expect(info.droppedCount).toBe(5);
    expect(info.reason).toBe('queue_full');
  });

  test('a disconnected queue retains every message without an implicit count limit', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];
    const messages = Array.from({ length: 1025 }, (_, index) => JSON.stringify({ type: 'x', index }));
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      onBackpressure: info => bpEvents.push(info),
      onEmitter: emit => { for (const message of messages) emit(message); },
    });
    const pending = connector('agents', () => {});
    await settleEvents(10);
    expect(bpEvents).toEqual([]);
    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
    await settleEvents(10);
    const stop = await pending;
    expect(firstInstance(instances).sentMessages.slice(-messages.length)).toEqual(messages);
    stopOrThrow(stop);
  });

  test('a large queued message is delivered in full without an implicit byte limit', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];
    const payload = { type: 'large-fixture', text: 'x'.repeat(1048577) };
    const message = JSON.stringify(payload);
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      onBackpressure: info => bpEvents.push(info), onEmitter: emit => emit(message),
    });
    const pending = connector('agents', () => {});
    await settleEvents(10);
    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
    await settleEvents(10);
    const stop = await pending;
    expect(bpEvents).toEqual([]);
    const assembler = new WebSocketMessageAssembler();
    const received = firstInstance(instances).sentMessages.map(frame => assembler.accept(JSON.parse(frame))).filter(value => value !== undefined);
    expect(received).toEqual([{ type: 'auth', token: 'tok', domains: ['agents'] }, payload]);
    stopOrThrow(stop);
  });

  test('reconnection flushes the entire queued batch in order each time', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];
    let emit!: (data: string) => void;
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onBackpressure: info => bpEvents.push(info), onEmitter: fn => { emit = fn; },
    });
    const pending = connector('agents', () => {});
    await settleEvents(10);
    const first = Array.from({ length: 1025 }, (_, i) => `first-${i}`);
    first.forEach(emit);
    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
    await settleEvents(10);
    const stop = await pending;
    expect(firstInstance(instances).sentMessages.slice(-first.length)).toEqual(first);
    firstInstance(instances).simulateClose(1006);
    await settleEvents(10);
    const second = Array.from({ length: 1025 }, (_, i) => `second-${i}`);
    second.forEach(emit);
    expect(instances).toHaveLength(2);
    instances[1]!.simulateOpen();
    await settleEvents(10);
    instances[1]!.simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
    await settleEvents(10);
    expect(instances[1]!.sentMessages.slice(-second.length)).toEqual(second);
    expect(bpEvents).toEqual([]);
    stopOrThrow(stop);
  });
});

// ---------------------------------------------------------------------------
// WS error envelope parity
// ---------------------------------------------------------------------------
describe('WS error envelope parity', () => {
  test('createWebSocketRemoteError falls back to fallbackMessage for non-structured body', () => {
    const err = createWebSocketRemoteError('Something went wrong', { some: 'object' });
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Something went wrong');
    expect(err.code).toBe('WS_REMOTE_ERROR');
  });

  test('createWebSocketRemoteError uses body string directly when body is a non-empty string', () => {
    const err = createWebSocketRemoteError('fallback', 'Server said no');
    expect(err.message).toBe('Server said no');
  });

  test('createWebSocketRemoteError unpacks structured daemon error body', () => {
    const body = {
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      category: 'rate_limit',
      recoverable: true,
      hint: 'Wait 60 seconds before retrying.',
      requestId: 'req-abc',
    };
    const err = createWebSocketRemoteError('fallback', body);
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Rate limit exceeded');
    // The transport code is always a canonical WS code ('WS_REMOTE_ERROR');
    // the server's body.code is not used as the error code since Symbol.hasInstance
    // enforces a canonical-code allowlist. The server's metadata (category, recoverable,
    // hint, requestId) is preserved on the error object.
    expect(err.code).toBe('WS_REMOTE_ERROR');
    expect(err.category).toBe('rate_limit');
    expect(err.recoverable).toBe(true);
    expect(err.hint).toBe('Wait 60 seconds before retrying.');
    expect(err.requestId).toBe('req-abc');
  });

  test('createWebSocketRemoteError respects caller code override for non-structured body', () => {
    const err = createWebSocketRemoteError('fallback', null, { code: 'WS_CLOSE_ABNORMAL', hint: 'reconnect' });
    expect(err.code).toBe('WS_CLOSE_ABNORMAL');
    expect(err.hint).toBe('reconnect');
  });

  test('WebSocketTransportError constructor accepts extended options for parity with HttpStatusError', () => {
    const err = new WebSocketTransportError('Auth failed over WS', {
      code: 'WS_REMOTE_ERROR',
      category: 'authentication',
      recoverable: false,
      status: 401,
      requestId: 'req-xyz',
    });
    expect(err.category).toBe('authentication');
    expect(err.recoverable).toBe(false);
    expect(err.status).toBe(401);
    expect(err.requestId).toBe('req-xyz');
  });

  test('WebSocketTransportError defaults to network/recoverable when category/recoverable omitted', () => {
    const err = new WebSocketTransportError('WS error', { code: 'WS_EVENT_ERROR' });
    expect(err.category).toBe('network');
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Granular progress event contracts
// ---------------------------------------------------------------------------
describe('granular progress event contracts', () => {
  test('BATCH_JOB_PROGRESS event shape satisfies TaskEvent union', () => {
    const event: TaskEvent = {
      type: 'BATCH_JOB_PROGRESS',
      operationId: 'op-1',
      phase: 'embedding',
      completed: 50,
      total: 200,
      percent: 25,
      message: 'Processing documents...',
    };
    expect(event.type).toBe('BATCH_JOB_PROGRESS');
    // Narrowing works:
    if (event.type === 'BATCH_JOB_PROGRESS') {
      expect(event.operationId).toBe('op-1');
      expect(event.phase).toBe('embedding');
      expect(event.completed).toBe(50);
      expect(event.total).toBe(200);
      expect(event.percent).toBe(25);
    }
  });

  test('BATCH_JOB_PROGRESS event shape works with optional fields absent', () => {
    const event: TaskEvent = {
      type: 'BATCH_JOB_PROGRESS',
      operationId: 'op-2',
      phase: 'indexing',
      completed: 10,
    };
    expect(event.type).toBe('BATCH_JOB_PROGRESS');
    if (event.type === 'BATCH_JOB_PROGRESS') {
      expect(event.total).toBeUndefined();
      expect(event.percent).toBeUndefined();
      expect(event.message).toBeUndefined();
    }
  });

  test('EXPORT_PROGRESS event shape satisfies TaskEvent union', () => {
    const event: TaskEvent = {
      type: 'EXPORT_PROGRESS',
      operationId: 'export-1',
      phase: 'serializing',
      completed: 1000,
      total: 5000,
      percent: 20,
      message: 'Exporting sessions...',
    };
    expect(event.type).toBe('EXPORT_PROGRESS');
    if (event.type === 'EXPORT_PROGRESS') {
      expect(event.operationId).toBe('export-1');
      expect(event.phase).toBe('serializing');
    }
  });

  test('KNOWLEDGE_INGEST_PROGRESS event shape satisfies KnowledgeEvent union', () => {
    const event: KnowledgeEvent = {
      type: 'KNOWLEDGE_INGEST_PROGRESS',
      operationId: 'ingest-1',
      phase: 'chunking',
      completed: 30,
      total: 100,
      percent: 30,
      message: 'Processing chunk 30/100',
    };
    expect(event.type).toBe('KNOWLEDGE_INGEST_PROGRESS');
    if (event.type === 'KNOWLEDGE_INGEST_PROGRESS') {
      expect(event.operationId).toBe('ingest-1');
      expect(event.phase).toBe('chunking');
    }
  });

  test('KNOWLEDGE_INGEST_PROGRESS works with optional fields absent', () => {
    const event: KnowledgeEvent = {
      type: 'KNOWLEDGE_INGEST_PROGRESS',
      operationId: 'ingest-2',
      phase: 'embedding',
      completed: 0,
    };
    if (event.type === 'KNOWLEDGE_INGEST_PROGRESS') {
      expect(event.total).toBeUndefined();
      expect(event.percent).toBeUndefined();
      expect(event.message).toBeUndefined();
    }
  });

  test('TRANSPORT_BACKPRESSURE event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_BACKPRESSURE',
      transportId: 'agents-ws',
      droppedCount: 5,
      queueLength: 1024,
      queueBytes: 2048,
      reason: 'queue_full',
    };
    expect(event.type).toBe('TRANSPORT_BACKPRESSURE');
  });

  test('TRANSPORT_CONNECTION_STATE event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_CONNECTION_STATE',
      transportId: 'agents-ws',
      state: 'reconnecting',
    };
    expect(event.type).toBe('TRANSPORT_CONNECTION_STATE');
    if (event.type === 'TRANSPORT_CONNECTION_STATE') {
      expect(event.state).toBe('reconnecting');
    }
  });

  test('TRANSPORT_RECONNECT_ATTEMPT event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_RECONNECT_ATTEMPT',
      transportId: 'agents-ws',
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: 'connection closed',
    };
    expect(event.type).toBe('TRANSPORT_RECONNECT_ATTEMPT');
  });
});

// ---------------------------------------------------------------------------
// onTransportEvent: typed events dispatched by connector
// ---------------------------------------------------------------------------
describe('onTransportEvent typed event dispatch', () => {
  test('onTransportEvent receives TRANSPORT_CONNECTION_STATE on each state transition', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // Before open: 'connecting' event from connect()
    const connectingEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE',
    );
    expect(connectingEvents.length).toBeGreaterThanOrEqual(1);
    expect(connectingEvents[0]!.state).toBe('connecting');

    firstInstance(instances).simulateOpen();
    await settleEvents(10);

    const stateEvents = events
      .filter((e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE')
      .map((e) => e.state);

    // Exact sequence pin: connecting then connected, no duplicates
    expect(stateEvents).toEqual(['connecting', 'connected']);

    stopOrThrow(stop);
    await settleEvents(0);

    const afterStop = events
      .filter((e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE')
      .map((e) => e.state);
    expect(afterStop).toContain('disconnected');
  });

  test('onTransportEvent receives TRANSPORT_RECONNECT_ATTEMPT with full metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateClose(1006, 'server error');
    await settleEvents(10);

    const reconnectEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_RECONNECT_ATTEMPT' } =>
        e.type === 'TRANSPORT_RECONNECT_ATTEMPT',
    );
    expect(reconnectEvents.length).toBeGreaterThanOrEqual(1);
    const first = reconnectEvents[0]!;
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(5);
    expect(typeof first.delayMs).toBe('number');
    expect(first.reason.length).toBeGreaterThan(0);

    stopOrThrow(stop);
  });

  test('onTransportEvent does not report backpressure for a fully retained queue', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, {
      onTransportEvent: event => events.push(event),
      onEmitter: emit => { for (let i = 0; i < 1025; i++) emit(`message-${i}`); },
    });
    const pending = connector('agents', () => {});
    await settleEvents(10);
    firstInstance(instances).simulateOpen();
    await settleEvents(10);
    firstInstance(instances).simulateMessage(JSON.stringify({ type: 'auth', ok: true }));
    await settleEvents(10);
    const stop = await pending;
    expect(events.filter(event => event.type === 'TRANSPORT_BACKPRESSURE')).toEqual([]);
    expect(firstInstance(instances).sentMessages.filter(message => message.startsWith('message-'))).toHaveLength(1025);
    stopOrThrow(stop);
  });

  test('code 1005 (No Status Received) schedules reconnect: not a clean close per RFC 6455 §7.4.1', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);

    // simulateClose with code 1005 sets wasClean: false (code !== 1000 in the harness)
    firstInstance(instances).simulateClose(1005, '');
    await settleEvents(20);

    // 1005 is NOT a clean close, connector must schedule a reconnect
    expect(states).toContain('reconnecting');
    const reconnectEvents = events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT');
    expect(reconnectEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('clean close (code 1000) does NOT trigger reconnect: state sequence is connecting→connected→disconnected', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});

    firstInstance(instances).simulateOpen();
    await settleEvents(10);

    // Simulate clean server-side close
    firstInstance(instances).simulateClose(1000, 'normal closure');
    await settleEvents(20);

    // Must NOT see 'reconnecting' after a clean close
    expect(states).not.toContain('reconnecting');
    // Must see 'disconnected' (emitted by onClose clean path)
    expect(states).toContain('disconnected');
    // No TRANSPORT_RECONNECT_ATTEMPT event should be dispatched
    const reconnectEvents = events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT');
    expect(reconnectEvents).toHaveLength(0);
  });
});
