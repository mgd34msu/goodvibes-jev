import { constants, closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendWebSocketMessage, WEBSOCKET_CHUNK_CHARS } from '@goodvibes-jev/engine/transport-core';

/** A slow socket spills queued events to a private file, without losing events or retaining their bodies in memory. */
export class WebSocketOutbox {
  private readonly lifetime = new AbortController();
  private directory: string | undefined;
  private fd: number | undefined;
  private offset = 0;
  private readonly records: { offset: number; length: number }[] = [];
  private running = false;
  constructor(private readonly socket: { send(data: string): unknown; getBufferedAmount?(): number; close?(code: number, reason: string): void }) {}
  send(text: string): void {
    if (this.lifetime.signal.aborted) return;
    if (!this.running && text.length <= WEBSOCKET_CHUNK_CHARS && (this.socket.getBufferedAmount?.() ?? 0) <= 4 * 1024 * 1024) {
      this.socket.send(text); return;
    }
    if (this.fd === undefined) {
      this.directory = mkdtempSync(join(tmpdir(), 'goodvibes-ws-'));
      this.fd = openSync(join(this.directory, 'outbox'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    }
    const bytes = Buffer.from(text);
    const offset = this.offset;
    let written = 0;
    while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written, offset + written);
    this.offset += bytes.length;
    this.records.push({ offset, length: bytes.length });
    if (!this.running) void this.drain();
  }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.records.length && !this.lifetime.signal.aborted) {
        const record = this.records.shift()!;
        const bytes = Buffer.alloc(record.length);
        let read = 0;
        while (read < bytes.length) {
          const n = readSync(this.fd!, bytes, read, bytes.length - read, record.offset + read);
          if (!n) throw new Error('Incomplete WebSocket outbox');
          read += n;
        }
        await sendWebSocketMessage(this.socket, bytes.toString('utf8'), this.lifetime.signal);
      }
    } catch { this.lifetime.abort(); this.records.length = 0; this.socket.close?.(1011, 'WebSocket delivery failed'); }
    finally { this.running = false; this.cleanup(); }
  }
  close(): void { this.lifetime.abort(); this.records.length = 0; this.cleanup(); }
  private cleanup(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.directory !== undefined) { rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
    this.offset = 0;
  }
}
