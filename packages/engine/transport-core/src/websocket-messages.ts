/** Logical messages are split into small frames; frame size is not a work limit. */
export const WEBSOCKET_CHUNK_CHARS = 64 * 1024;
export function* encodeWebSocketMessage(text: string): Generator<string> {
  if (text.length <= WEBSOCKET_CHUNK_CHARS) { yield text; return; }
  const id = crypto.randomUUID();
  for (let offset = 0, index = 0; offset < text.length; offset += WEBSOCKET_CHUNK_CHARS, index++) {
    yield JSON.stringify({ type: 'chunk', id, index, final: offset + WEBSOCKET_CHUNK_CHARS >= text.length, data: text.slice(offset, offset + WEBSOCKET_CHUNK_CHARS) });
  }
}

/** One ordered connection owns one partial message. Never share across reconnects. */
export class WebSocketMessageAssembler {
  private id: string | undefined;
  private parts: string[] = [];
  reset(): void { this.id = undefined; this.parts = []; }
  accept(frame: unknown): unknown | undefined {
    if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'chunk') return frame;
    const chunk = frame as Record<string, unknown>;
    if (typeof chunk.id !== 'string' || !Number.isSafeInteger(chunk.index) || typeof chunk.data !== 'string' || typeof chunk.final !== 'boolean'
      || chunk.data.length > WEBSOCKET_CHUNK_CHARS || chunk.index !== this.parts.length || (this.id !== undefined && chunk.id !== this.id)) {
      this.reset(); throw new Error('Invalid or out-of-order WebSocket chunk');
    }
    this.id = chunk.id;
    this.parts.push(chunk.data);
    if (!chunk.final) return undefined;
    const text = this.parts.join('');
    this.reset();
    return JSON.parse(text) as unknown;
  }
}

/** Pause native writes at a high-water mark; producers await delivery or cancellation. */
export async function sendWebSocketMessage(
  socket: { send(data: string): unknown; readonly bufferedAmount?: number; getBufferedAmount?(): number },
  text: string, signal?: AbortSignal,
): Promise<void> {
  for (const frame of encodeWebSocketMessage(text)) {
    signal?.throwIfAborted();
    while ((socket.getBufferedAmount?.() ?? socket.bufferedAmount ?? 0) > 4 * 1024 * 1024) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('WebSocket send cancelled')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 10);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
    }
    socket.send(frame);
  }
}
