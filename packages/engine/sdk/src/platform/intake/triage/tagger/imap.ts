// ---------------------------------------------------------------------------
// Triage tagger, IMAP provider.
//
// Applies a triage label as an IMAP keyword flag (STORE +FLAGS) over a minimal
// IMAP4rev1-over-TLS client. Credentials are resolved per-apply from the daemon
// credential store and are NEVER logged or returned. CRLF/control characters in
// any interpolated command value are rejected (CRLF-injection guard). Transient
// network failures are retried with bounded exponential backoff; protocol-level
// NO/BAD rejections are deterministic and never retried.
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
const summarizeError = (_error: unknown): string => 'IMAP transport failed';

export interface ImapStoreArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  uid: string;
  flag: string;
  uidValidity: number;
  signal: AbortSignal;
  assertCurrent(): void;
}

export interface ImapRetryOptions {
  /** Total attempts including the first (default 3). Values < 1 disable retry. */
  maxAttempts?: number;
  /** Base backoff in ms for the first retry (default 250). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms (default 2000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type ImapStoreFlag = (args: ImapStoreArgs) => Promise<void>;

/**
 * The minimal subset of a node:tls TLSSocket that imapStoreFlagOverTls drives.
 * Declaring it explicitly (rather than depending on the full TLSSocket surface)
 * gives the data-pump a precise injection seam: tests can supply an in-memory
 * duplex that exercises the protocol state machine without a real network
 * socket, while the production path passes the real tlsConnect result.
 */
export interface ImapSocketLike {
  setEncoding(encoding: string): void;
  setTimeout(ms: number, callback: () => void): void;
  write(data: string): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  destroy(): void;
}

/** Connector seam: opens an ImapSocketLike for the given host/port. */
export type ImapConnect = (opts: {
  host: string;
  port: number;
  servername: string;
}) => ImapSocketLike;

/** Production connector, a real IMAP4rev1-over-TLS socket via node:tls. */
export const tlsImapConnect: ImapConnect = (opts) =>
  tlsConnect(opts, () => {
    /* greeting handled in the data pump */
  }) as unknown as ImapSocketLike;

/**
 * Error subclass carrying whether a failure is transient (worth retrying) or a
 * deterministic protocol rejection (NO/BAD) that must not be retried.
 */
export class ImapStoreError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ImapStoreError';
    this.transient = transient;
  }
}

/**
 * Reject CR, LF, NUL and any other ASCII control character (0x00-0x1F, 0x7F)
 * in a value destined for an IMAP command line. CR/LF are the dangerous ones:
 * an unescaped CRLF would terminate the current command and let an attacker
 * inject a second IMAP command (CRLF injection). IMAP's quoted-string syntax
 * has no escape for these control chars, backslash only escapes `\` and `"`,
 * so the only safe handling is to refuse the value outright.
 */
function assertImapSafe(value: string, field: string): void {
  // eslint-disable-next-line no-control-regex -- intentional control-char guard
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new ImapStoreError(
      `IMAP ${field} contains illegal control characters (possible CRLF injection)`,
      false,
    );
  }
}

/**
 * Wrap a value as an IMAP quoted string. Backslash and double-quote are escaped
 * per RFC 3501; control characters are NOT escapable in the quoted-string
 * grammar, so callers MUST validate with assertImapSafe first. quoteImap
 * re-asserts as defense-in-depth so no future caller can bypass the guard.
 */
function quoteImap(value: string): string {
  assertImapSafe(value, 'value');
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

// A concrete UID sequence-set: one or more comma-separated single UIDs or
// numeric ranges (`12`, `3:9`, `1,4,7:9`). RFC 3501 also permits `*` (the
// largest UID in the mailbox) and ranges to `*`, but a wildcard would let a
// single value like `1:*` apply the flag to the ENTIRE mailbox, never the
// intent when tagging one triaged item, so `*` is rejected outright.
const IMAP_UID_SET = /^[0-9]+(:[0-9]+)?(,[0-9]+(:[0-9]+)?)*$/;

// An IMAP flag: an optional leading `\` (system flag, e.g. `\Seen`) followed by
// atom characters only. The atom grammar excludes SP and the list/quoting
// specials `(){%*"\` and `]`, so a flag cannot contain a space (which would
// otherwise inject a second flag atom into the `+FLAGS (...)` list) or close
// the parenthesised list early.
// eslint-disable-next-line no-control-regex -- atom grammar excludes controls
const IMAP_FLAG = /^\\?[^\s(){%*"\\\]\x00-\x1F\x7F]+$/;

/**
 * Validate an IMAP UID value as a concrete sequence-set before it is
 * interpolated UNQUOTED into `UID STORE`. assertImapSafe only blocks control
 * chars; a control-char-free wildcard like `1:*` would still pass that guard
 * and mutate the whole mailbox. This is the boundary check that prevents it.
 */
function assertImapUid(value: string): void {
  if (!IMAP_UID_SET.test(value)) {
    throw new ImapStoreError(
      `IMAP uid is not a valid numeric sequence-set: ${JSON.stringify(value)}`,
      false,
    );
  }
}

/**
 * Validate an IMAP flag against the flag/atom grammar before it is interpolated
 * UNQUOTED into the `+FLAGS (...)` list. assertImapSafe only blocks control
 * chars; a flag containing a space (e.g. `\Seen Junk`) would still pass that
 * guard and inject a second flag atom. This is the boundary check that
 * prevents it, independent of any upstream normalizer.
 */
function assertImapFlag(value: string): void {
  if (!IMAP_FLAG.test(value)) {
    throw new ImapStoreError(
      `IMAP flag is not a valid flag-keyword atom: ${JSON.stringify(value)}`,
      false,
    );
  }
}

/**
 * Minimal IMAP4rev1 client: connect over TLS, LOGIN, SELECT, UID STORE +FLAGS,
 * LOGOUT. Uses only node:tls (Bun-compatible).
 *
 * Tagged-command sequencing uses an explicit completion flag rather than a line
 * heuristic: the LOGOUT step is tracked by reference, so its tagged OK (or an
 * untagged `* BYE`) cleanly completes the operation and tells the `close`
 * handler the disconnect was expected. Connection/timeout/socket failures are
 * surfaced as transient ImapStoreError; NO/BAD protocol responses as
 * non-transient.
 */
export function imapStoreFlagOverTls(
  args: ImapStoreArgs,
  connect: ImapConnect = tlsImapConnect,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      assertImapSafe(args.user, 'user');
      assertImapSafe(args.password, 'password');
      assertImapSafe(args.mailbox, 'mailbox');
      assertImapSafe(args.uid, 'uid');
      assertImapSafe(args.flag, 'flag');
      // uid and flag are interpolated UNQUOTED below; the control-char guard
      // alone is insufficient, so enforce the structural grammar here too.
      assertImapUid(args.uid);
      if (!/^[1-9][0-9]*$/.test(args.uid) || !Number.isSafeInteger(args.uidValidity) || args.uidValidity < 1) throw new ImapStoreError('IMAP target unavailable', false);
      args.signal.throwIfAborted(); args.assertCurrent();
      assertImapFlag(args.flag);
    } catch (err) {
      reject(
        err instanceof ImapStoreError
          ? err
          : new ImapStoreError(summarizeError(err), false),
      );
      return;
    }
    type Step = { tag: string; isLogout: boolean; isSelect: boolean; resolve: () => void; reject: (e: Error) => void };

    let done = false;
    let completed = false; // LOGOUT acknowledged (or BYE seen), so close is expected.
    let buffer = '';
    let pending: Step | null = null;
    let counter = 0;
    let greeted = false;
    let validity: number | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(new ImapStoreError('IMAP operation revoked', false));

    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline); args.signal.removeEventListener('abort', abort);
      const waiting = pending; pending = null;
      if (waiting) waiting.reject(err ?? new ImapStoreError('IMAP operation retired', false));
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };

    const socket: ImapSocketLike = connect({
      host: args.host,
      port: args.port,
      servername: args.host,
    });
    deadline = setTimeout(() => finish(new ImapStoreError('IMAP operation timed out', true)), 20_000);
    args.signal.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf-8');
    socket.setTimeout(20_000, () =>
      finish(new ImapStoreError('IMAP connection timed out', true)),
    );

    const send = (command: string, isLogout = false, isSelect = false): Promise<void> =>
      new Promise<void>((res, rej) => {
        if (done) { rej(new ImapStoreError('IMAP operation retired', false)); return; }
        args.signal.throwIfAborted(); args.assertCurrent();
        counter += 1;
        const tag = `A${counter}`;
        pending = { tag, isLogout, isSelect, resolve: res, reject: rej };
        socket.write(`${tag} ${command}\r\n`);
      });

    const runSequence = async (): Promise<void> => {
      await send(`LOGIN ${quoteImap(args.user)} ${quoteImap(args.password)}`);
      validity = undefined;
      await send(`SELECT ${quoteImap(args.mailbox)}`, false, true);
      if (validity !== args.uidValidity) throw new ImapStoreError('IMAP UIDVALIDITY changed or unavailable', false);
      await send(`UID STORE ${args.uid} +FLAGS (${args.flag})`);
      await send('LOGOUT', true);
    };

    const handleLine = (line: string): void => {
      if (done) return;
      const observed = /^\* OK \[UIDVALIDITY ([0-9]+)\]/i.exec(line);
      if (observed && pending?.isSelect) validity = Number(observed[1]);
      if (!greeted) {
        greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(line)) {
          finish(new ImapStoreError(`IMAP server rejected connection`, true));
          return;
        }
        runSequence().catch((err) =>
          finish(
            err instanceof ImapStoreError
              ? err
              : new ImapStoreError(summarizeError(err), false),
          ),
        );
        return;
      }

      // An untagged BYE during LOGOUT is the server announcing a clean close.
      if (/^\* BYE/i.test(line) && pending?.isLogout) {
        completed = true;
        return;
      }

      if (!pending) return;
      if (!line.startsWith(`${pending.tag} `)) return; // untagged data line
      const status = line.slice(pending.tag.length + 1);
      const current = pending;
      pending = null;
      if (/^OK(?: |$)/i.test(status)) {
        current.resolve();
        if (current.isLogout) {
          completed = true;
          finish();
        }
      } else {
        // NO/BAD: deterministic protocol rejection, do not retry.
        current.reject(new ImapStoreError(`IMAP command rejected`, false));
      }
    };

    socket.on('error', (err) =>
      finish(new ImapStoreError(summarizeError(err), true)),
    );
    socket.on('close', () => {
      if (completed) finish();
      else finish(new ImapStoreError('IMAP connection closed unexpectedly', true));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 65536) { finish(new ImapStoreError('IMAP response exceeds bound', false)); return; }
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    });
  });
}

/** True when an error is worth retrying (network/connection, not protocol). */
function isTransientImapError(error: unknown): boolean {
  if (error instanceof ImapStoreError) return error.transient;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
      .includes(code);
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Wrap an IMAP store function with bounded exponential-backoff retry on
 * transient failures only. Protocol-level (NO/BAD) errors are surfaced on the
 * first attempt without retry.
 */
export function makeRetryingImapStoreFlag(
  inner: ImapStoreFlag,
  retry: ImapRetryOptions = {},
): ImapStoreFlag {
  const maxAttempts = Number.isFinite(retry.maxAttempts ?? 3) ? Math.min(5, Math.max(1, Math.floor(retry.maxAttempts ?? 3))) : 3;
  const baseDelayMs = Number.isFinite(retry.baseDelayMs ?? 250) ? Math.min(2_000, Math.max(0, retry.baseDelayMs ?? 250)) : 250;
  const maxDelayMs = Number.isFinite(retry.maxDelayMs ?? 2_000) ? Math.min(2_000, Math.max(baseDelayMs, retry.maxDelayMs ?? 2_000)) : 2_000;
  const sleep = retry.sleep ?? defaultSleep;

  return async (args: ImapStoreArgs): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        args.signal.throwIfAborted(); args.assertCurrent();
        await inner(args);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientImapError(error)) throw error;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
    throw lastError;
  };
}
