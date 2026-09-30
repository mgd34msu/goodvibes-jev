// ---------------------------------------------------------------------------
// Minimal, dependency-free IMAPS client (RFC 3501 subset) over node:tls.
//
// Implements exactly what the inbound poller needs:
//   LOGIN, SELECT, UID SEARCH (SINCE / ALL), UID FETCH (ENVELOPE + body peek),
//   LOGOUT. No external npm dependency, uses node:tls (Bun-compatible).
//
// This is intentionally conservative: line-buffered tagged-command protocol,
// per-command timeout, and a hard cap on response size to avoid unbounded
// memory growth from a hostile/large mailbox.
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
import { hasTaggedCompletion, parseIntakeFetchResponse, taggedStatus } from './imap-response.js';
export { decodeHeader } from './imap-response.js';
export { parseIntakeFetchResponse as parseFetchResponse } from './imap-response.js';
/** Narrow transport seam; production uses TLS, tests use an in-memory socket. */
export interface ImapSocket {
  setEncoding(encoding: string): unknown;
  write(data: string): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  destroy(): unknown;
}
export type ImapConnector = (
  options: { host: string; port: number; servername: string },
  onSecure: () => void,
) => ImapSocket;

export interface ImapConfig {
  host: string;
  port: number; // 993 for IMAPS
  user: string;
  password: string;
  /** Per-command timeout in ms. */
  timeoutMs?: number;
  /** Hard cap on bytes buffered per command (defense against huge fetches). */
  maxResponseBytes?: number;
}

export interface ImapEnvelope {
  uid: number;
  from: string; // raw From header value (digested by the adapter)
  subject: string;
  date: number; // Unix ms (0 when unparseable)
  seen: boolean;
  bodyPreview: string; // first text fragment, raw (sanitized by the adapter)
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ImapClient {
  private socket: ImapSocket | null = null;
  private tagCounter = 0;
  private buffer = '';
  private busy = false;
  private closed = false;
  private ready = false;
  private readonly idleError = (): void => {
    // Command listeners first receive the error in this emission. The owned
    // socket also needs an observer between commands to avoid an unhandled
    // EventEmitter error. Close after those listeners have settled.
    queueMicrotask(() => this.close());
  };
  private readonly cfg: Required<ImapConfig>;

  constructor(cfg: ImapConfig, private readonly connector: ImapConnector = tlsConnect) {
    this.cfg = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      ...cfg,
    };
    if (!Number.isSafeInteger(this.cfg.port) || this.cfg.port < 1 || this.cfg.port > 65_535
      || !Number.isFinite(this.cfg.timeoutMs) || this.cfg.timeoutMs <= 0
      || !Number.isSafeInteger(this.cfg.maxResponseBytes) || this.cfg.maxResponseBytes <= 0) {
      throw new Error('Invalid IMAP connection bounds');
    }
  }

  async connect(): Promise<void> {
    if (this.closed || this.socket) throw new Error('IMAP client is closed or already connected');
    let ready!: () => void;
    let refuse!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; refuse = reject; });
    const socket = this.connector(
      { host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host }, ready,
    );
    this.socket = socket;
    socket.setEncoding('utf-8');
    socket.on('error', this.idleError);
    const onError = (): void => refuse(new Error('IMAP TLS connection failed'));
    const onClose = (): void => refuse(new Error('IMAP connection closed during connect'));
    socket.once('error', onError);
    socket.on('close', onClose);
    const timer = setTimeout(() => {
      refuse(new Error('IMAP TLS connect timeout'));
      this.close();
    }, this.cfg.timeoutMs);
    try {
      // Arm the greeting reader before the TLS callback: an eager server may
      // deliver its greeting in the same turn as the successful connection.
      const [, greeting] = await Promise.all([
        connected, this.readUntil(chunk => /\r?\n/.test(chunk), 'greeting'),
      ]);
      if (!/^\* OK\b/i.test(greeting)) throw new Error('IMAP server refused the connection');
      this.ready = true;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
  }

  async login(): Promise<void> {
    const user = quote(this.cfg.user);
    const pass = quote(this.cfg.password);
    await this.command(`LOGIN ${user} ${pass}`);
  }

  /** SELECT a mailbox (default INBOX). */
  async select(mailbox = 'INBOX'): Promise<void> {
    await this.command(`SELECT ${quote(mailbox)}`);
  }

  /** UID SEARCH; returns matching UIDs. `since` filters by internal date. */
  async searchUids(since?: number): Promise<number[]> {
    if (since !== undefined && !Number.isFinite(since)) throw new Error('Invalid IMAP search date');
    const criteria = since ? `SINCE ${imapDate(since)}` : 'ALL';
    const lines = (await this.command(`UID SEARCH ${criteria}`)).split(/\r?\n/);
    const uids: number[] = [];
    for (const line of lines) {
      const match = /^\* SEARCH(.*)$/i.exec(line.trim());
      if (match) {
        for (const tok of match[1]!.trim().split(/\s+/)) {
          const n = Number(tok);
          if (/^\d+$/.test(tok) && Number.isSafeInteger(n) && n > 0) uids.push(n);
        }
      }
    }
    return uids;
  }

  /**
   * UID FETCH envelope + flags + a small text body peek for the given uids.
   * Returns one ImapEnvelope per uid that parsed successfully.
   */
  async fetchEnvelopes(uids: readonly number[]): Promise<ImapEnvelope[]> {
    if (uids.length === 0) return [];
    if (uids.some(uid => !Number.isSafeInteger(uid) || uid < 1)) throw new Error('Invalid IMAP UID');
    const set = uids.join(',');
    // BODY.PEEK[HEADER.FIELDS (...)] avoids setting \Seen; TEXT peek for preview.
    const response = await this.command(
      `UID FETCH ${set} (UID FLAGS INTERNALDATE `
        + `BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] `
        + `BODY.PEEK[TEXT]<0.600>)`,
    );
    return parseIntakeFetchResponse(response);
  }

  async logout(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // ignore logout failures
    }
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    this.buffer = '';
    if (this.socket) {
      this.socket.off('error', this.idleError);
      this.socket.destroy();
      this.socket = null;
    }
  }

  // -------------------------------------------------------------------------
  // Protocol plumbing
  // -------------------------------------------------------------------------

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${this.tagCounter.toString().padStart(4, '0')}`;
  }

  private requireSocket(): ImapSocket {
    if (!this.socket) throw new Error('IMAP socket not connected');
    return this.socket;
  }

  /** Send a tagged command and collect all response lines up to the tagged OK. */
  private async command(text: string): Promise<string> {
    if (!this.ready) throw new Error('IMAP connection is not ready');
    if (this.busy) throw new Error('IMAP command already in progress');
    this.busy = true;
    try {
      const tag = this.nextTag();
      const socket = this.requireSocket();
      const response = this.readUntil((buf) => hasTaggedCompletion(buf, tag), redactCommand(text));
      try { socket.write(`${tag} ${text}\r\n`); } catch { this.close(); }
      const raw = await response;
      const status = taggedStatus(raw, tag);
      if (status !== 'OK') {
        // A server may echo submitted credentials in its free-text rejection.
        // Status is sufficient here; never include that untrusted diagnostic.
        throw new Error(`IMAP command failed: ${redactCommand(text)} (${status ?? 'invalid status'})`);
      }
      // Header/body literals span lines that do not begin with '*'. Discarding
      // those lines reports an existing message as an empty envelope.
      return raw;
    } finally { this.busy = false; }
  }

  /** Read from the socket until `predicate(buffer)` is true or timeout. */
  private readUntil(predicate: (buf: string) => boolean, label: string): Promise<string> {
    const socket = this.requireSocket();
    return new Promise<string>((resolve, reject) => {
      const onData = (chunk: string): void => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer, 'utf8') > this.cfg.maxResponseBytes) {
          cleanup();
          reject(new Error(`IMAP response exceeded ${this.cfg.maxResponseBytes} bytes (${label})`));
          this.close();
          return;
        }
        if (predicate(this.buffer)) {
          const out = this.buffer;
          this.buffer = '';
          cleanup();
          resolve(out);
        }
      };
      const onError = (): void => {
        cleanup();
        reject(new Error(`IMAP transport failed during ${label}`));
        this.close();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error(`IMAP connection closed during ${label}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`IMAP timeout after ${this.cfg.timeoutMs}ms (${label})`));
        this.close();
      }, this.cfg.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Quote an IMAP astring, escaping backslashes and double quotes. */
function quote(value: string): string {
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error('IMAP quoted value contains forbidden control characters');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Never echo a LOGIN password in an error message. */
function redactCommand(text: string): string {
  const words = text.split(' ');
  return words[0] === 'UID' ? `UID ${words[1]}` : words[0]!;
}

/** Format a Unix-ms timestamp as an IMAP date (dd-Mon-yyyy). */
export function imapDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
