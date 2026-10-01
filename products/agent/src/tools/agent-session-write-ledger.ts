/**
 * Session write ledger, which absolute paths this session's own tools wrote.
 *
 * The read guard treats any dotted path segment as hidden and refuses it. That
 * is right for a user's `~/.netrc`, and wrong for a file the agent itself just
 * produced: writing `/home/u/.goodvibes-screen.png` and then being refused a
 * read of it costs a round trip and teaches the model nothing, because the
 * denial cannot distinguish "this might be your secret" from "you wrote this
 * one line ago". This ledger supplies that distinction.
 *
 * Only writes that SUCCEEDED are recorded: a path is staged when the tool call
 * is received (that is the only event carrying arguments) and committed when
 * the call reports success. A write that failed never created a file, so it
 * never earns a waiver.
 *
 * Session-scoped and in memory, nothing here is persisted or restored, so a
 * new process starts with an empty ledger and no path outlives the session
 * that wrote it. Both maps are bounded and evict oldest-first.
 */
import type { RuntimeEventBus, ToolEvent } from '@/runtime/index.ts';

/** Most written paths retained. Oldest entries are evicted first. */
const MAX_TRACKED_WRITES = 512;
/** Most in-flight calls staged at once, in case a call never reports an outcome. */
const MAX_PENDING_WRITES = 128;

/** Argument keys a file-writing tool uses for its destination. */
const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'file', 'target', 'destination'] as const;

const written = new Set<string>();
const pending = new Map<string, readonly string[]>();

/**
 * Normalizes separators and redundant path steps so the same file matches
 * however it was spelled.
 *
 * Deliberately does NOT resolve a relative path against an ambient working
 * directory: this module is reusable code with no owned root, and guessing one
 * could waive the read guard for a file the session never wrote. A relative
 * write therefore only matches a relative read of the same spelling, which is
 * the conservative direction, an unmatched path stays blocked.
 */
function canonicalPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/(?:^|\/)\.(?=\/)/g, '')
    .replace(/\/+$/, '');
}

function isWriteTool(tool: string): boolean {
  const name = tool.toLowerCase();
  // Deliberately narrower than the execution ledger's route classifier: only
  // tools that put file content on disk can grant a read waiver. Shell and
  // browser tools are excluded, their writes did not pass through the model.
  if (name.includes('exec') || name.includes('shell') || name.includes('bash')) return false;
  return name.includes('write') || name.includes('edit') || name.includes('patch');
}

function collectPaths(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) found.push(canonicalPath(value));
  }
  // Batch shapes: { files: [{ path }, ...] } / { edits: [{ path }, ...] }.
  for (const key of ['files', 'edits', 'writes']) {
    const list = args[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      for (const pathKey of PATH_ARGUMENT_KEYS) {
        const value = (entry as Record<string, unknown>)[pathKey];
        if (typeof value === 'string' && value.trim().length > 0) found.push(canonicalPath(value));
      }
    }
  }
  return found;
}

function commit(paths: readonly string[]): void {
  for (const path of paths) {
    // Re-inserting refreshes recency so a repeatedly-written path is not evicted.
    written.delete(path);
    written.add(path);
    while (written.size > MAX_TRACKED_WRITES) {
      const oldest = written.values().next();
      if (oldest.done) break;
      written.delete(oldest.value);
    }
  }
}

/**
 * Record that this session wrote `path`. Exposed for the tools that write
 * outside the runtime tool-event stream, and for tests.
 */
export function recordAgentSessionWrite(path: string): void {
  commit([canonicalPath(path)]);
}

/** Whether this session's own tools successfully wrote `path`. */
export function wasWrittenInAgentSession(path: string): boolean {
  return written.has(canonicalPath(path));
}

/** Number of paths currently tracked. */
export function agentSessionWriteCount(): number {
  return written.size;
}

/** Drop all recorded writes. Used when a session is torn down, and by tests. */
export function clearAgentSessionWrites(): void {
  written.clear();
  pending.clear();
}

/**
 * Feed the ledger from the runtime tool-event stream.
 *
 * @param runtimeBus - Bus carrying the `tools` domain events.
 * @returns Unsubscribe callback.
 */
export function attachAgentSessionWriteLedger(runtimeBus: RuntimeEventBus): () => void {
  return runtimeBus.onDomain('tools', (envelope) => {
    const event = envelope.payload as ToolEvent;
    if (!('callId' in event)) return;

    if (event.type === 'TOOL_RECEIVED') {
      if (!isWriteTool(event.tool)) return;
      const paths = collectPaths(event.args);
      if (paths.length === 0) return;
      pending.set(event.callId, paths);
      while (pending.size > MAX_PENDING_WRITES) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
      return;
    }

    const staged = pending.get(event.callId);
    if (!staged) return;
    if (event.type === 'TOOL_SUCCEEDED') commit(staged);
    // Any terminal outcome clears the staging slot; only success commits.
    if (event.type === 'TOOL_SUCCEEDED' || event.type === 'TOOL_FAILED' || event.type === 'TOOL_CANCELLED') {
      pending.delete(event.callId);
    }
  });
}
