/** One-shot evaluation and authority-owned attempt history. No host eval,
 * shared VM, host history file or model-selected workspace is available here. */
import { randomUUID } from 'node:crypto';
import {
  assertContractInputAuthority,
  assertContractInputReadAccess,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import type { Tool, ToolResult } from '../../types/tools.js';
import { guardExecCommand } from '../exec/ast-guard.js';
import { probeCapturedExecAvailability, runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { createCapturedExecBunRuntimeAdmission } from '../exec/captured-bun-runtime-input.js';
import { REPL_TOOL_SCHEMA } from './schema.js';
import type { ReplToolInput } from './schema.js';

const tools = new WeakMap<Tool, ContractInputAuthority>();
const HELD = 'Captured REPL held: original-owner/view authority is unavailable, changed, cancelled or restricted. Output withheld.';
const MAX_COMMAND_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
type Runtime = NonNullable<ReplToolInput['runtime']>;
interface HistoryEntry {
  readonly ts: number;
  readonly runtime: Runtime;
  readonly expression: string;
  readonly sessionId: string;
  readonly backend?: string | undefined;
  readonly launchSummary?: string | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}
interface RetainedEntry {
  readonly entry: HistoryEntry;
  readonly bytes: number;
  readonly check: (signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}
interface History {
  readonly authority: ContractInputAuthority;
  readonly signal?: AbortSignal | undefined;
  readonly entries: RetainedEntry[];
  bytes: number;
  omitted: number;
}
// A copied root, serialized session ID or newly minted authority never selects
// another execution's journal. Weak ownership also lets disposed runs be freed.
export interface CapturedReplHistory {
  readonly kind: 'captured-repl-history';
}
const histories = new WeakMap<CapturedReplHistory, History>();

/** Mint once per actual agent run, then reuse only for its registry rebuilds. */
export function createCapturedReplHistory(authority: ContractInputAuthority, signal?: AbortSignal): CapturedReplHistory {
  const owner = Object.freeze({ kind: 'captured-repl-history' as const });
  histories.set(owner, { authority, signal, entries: [], bytes: 0, omitted: 0 });
  return owner;
}

export function disposeCapturedReplHistory(owner: CapturedReplHistory): void {
  histories.delete(owner);
}

function historyOf(owner: CapturedReplHistory, authority: ContractInputAuthority): History {
  const history = histories.get(owner);
  if (!history || history.authority !== authority) throw new Error('captured REPL history binding is unavailable');
  history.signal?.throwIfAborted();
  return history;
}

function retain(history: History, entry: HistoryEntry, check: RetainedEntry['check'], signal?: AbortSignal): void {
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  // Do not silently truncate a completion/error into a different result.
  if (bytes > MAX_HISTORY_BYTES) { history.omitted++; return; }
  while (history.entries.length >= MAX_HISTORY_ENTRIES || history.bytes + bytes > MAX_HISTORY_BYTES) {
    history.bytes -= history.entries.shift()!.bytes;
    history.omitted++;
  }
  history.entries.push({ entry: Object.freeze(entry), bytes, check, signal });
  history.bytes += bytes;
}

export function isCapturedReplTool(tool: Tool, authority: ContractInputAuthority): boolean {
  return tools.get(tool) === authority;
}

export function createCapturedReplTool(
  binding: CapturedExecAuthority,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  historyOwner: CapturedReplHistory = createCapturedReplHistory(binding.authority, binding.signal),
): Tool {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  const admitRuntime = binding.bunRuntimeAdmission ?? createCapturedExecBunRuntimeAdmission(binding);
  const check = async (callSignal?: AbortSignal): Promise<void> => {
    const signal = binding.signal && callSignal ? AbortSignal.any([binding.signal, callSignal]) : binding.signal ?? callSignal;
    await assertContractInputAuthority(binding.authority, binding.root, signal);
    await assertContractInputReadAccess(binding.authority, binding.readAccessFilter, signal);
    historyOf(historyOwner, binding.authority);
  };
  const tool: Tool = {
    definition: {
      ...REPL_TOOL_SCHEMA,
      description: 'Evaluate one JavaScript or TypeScript snippet in a fresh contained captured workspace. Bindings are JSON values exposed as globals. Returns printed completion and console output. Each eval is stateless (no shared variables or VM); authorized file changes persist only in a mutable member view. History lists authorized attempts for this captured run in the current process, retaining at most 100 entries and 2 MiB. History is not inherited by another run or resumed/rebound authority and never reads host history files. Network, ambient host environment and other runtimes are unavailable.',
      sideEffects: ['exec', 'read_fs', 'write_fs', 'state'],
      concurrency: 'serial',
    },
    async execute(args, options) {
      const signal = binding.signal && options?.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal ?? options?.signal;
      try {
        // Pin model input before the first policy await. Neither caller mutation
        // nor a workspaceRoot property can replace the construction binding.
        args = structuredClone(args);
        await check(signal);
        if (args.mode === 'history') {
          const history = historyOf(historyOwner, binding.authority);
          // The outer tool/provider delivery checks may cancel after this
          // backend completed. Such an attempt must not become replayable.
          for (let index = history.entries.length - 1; index >= 0; index--) {
            if (history.entries[index]!.signal?.aborted) {
              history.bytes -= history.entries[index]!.bytes;
              history.entries.splice(index, 1);
            }
          }
          const entries = [...history.entries];
          const omitted = history.omitted;
          const previousChecks = new Set(entries.map(entry => entry.check));
          previousChecks.delete(check);
          // Replaying through a newly constructed registry must not replace an
          // earlier binding's permission filter or lifecycle with a broader one.
          for (const originalCheck of previousChecks) await originalCheck(signal);
          for (const retained of entries) retained.signal?.throwIfAborted();
          const output = JSON.stringify({ count: entries.length, history: entries.map(entry => entry.entry),
            ...(omitted ? { omitted } : {}) });
          for (const originalCheck of previousChecks) await originalCheck(signal);
          await check(signal);
          for (const retained of entries) retained.signal?.throwIfAborted();
          return { success: true, output };
        }
        if (args.mode !== 'eval' || typeof args.expression !== 'string' || args.expression.length === 0)
          return { success: false, error: 'Captured REPL requires mode eval and a nonempty expression.' };
        const runtime = args.runtime ?? 'javascript';
        if (typeof runtime !== 'string' || !['javascript', 'typescript', 'python', 'sql', 'graphql'].includes(runtime))
          return { success: false, error: 'Captured REPL runtime is invalid.' };
        if (Buffer.byteLength(args.expression) > MAX_COMMAND_BYTES)
          return { success: false, error: 'Captured REPL expression and bindings exceed the 64 KiB command limit.' };
        const attempt = { ts: Date.now(), runtime: runtime as Runtime, expression: args.expression, sessionId: `captured_repl_${randomUUID()}` };
        const finish = async (result: Omit<ToolResult, 'callId'>, details: Partial<HistoryEntry> = {}): Promise<Omit<ToolResult, 'callId'>> => {
          await check(signal);
          // Cancelled/revoked attempts retain neither partial output nor source.
          if (!result.cancelled) retain(historyOf(historyOwner, binding.authority), { ...attempt, ...details, error: result.error ?? details.error }, check, signal);
          return result;
        };
        if (runtime !== 'javascript' && runtime !== 'typescript')
          return await finish({ success: false, error: 'Captured REPL currently supports only stateless JavaScript and TypeScript evaluation.' });
        if (!process.versions.bun)
          return await finish({ success: false, error: 'Captured REPL requires the trusted Bun runtime. Host evaluation is unavailable as a fallback.' });
        if (args.bindings !== undefined && (args.bindings === null || typeof args.bindings !== 'object' || Array.isArray(args.bindings)))
          return { success: false, error: 'Captured REPL bindings must be an object of JSON values.' };
        // JSON.parse preserves keys such as __proto__ as ordinary data. Defining
        // own globals avoids prototype assignment and needs no guessed identifier
        // classification. Code and bindings are a single literal shell argument.
        const bindings = JSON.stringify(args.bindings ?? {});
        const script = `Object.defineProperties(globalThis, Object.fromEntries(Object.entries(JSON.parse(${JSON.stringify(bindings)})).map(([key, value]) => [key, {value, configurable: true, writable: true}])));\n${args.expression}`;
        const command = `bun --no-env-file --print '${script.replace(/'/g, `'\\''`)}'`;
        if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
          return { success: false, error: 'Captured REPL expression and bindings exceed the 64 KiB command limit.' };
        // Preserve the existing semantic safety reading; the contained runtime
        // below is filesystem/process authority, never a replacement permission.
        const guard = await guardExecCommand(command, featureFlags, signal);
        await check(signal);
        if (!guard.allowed) return await finish({ success: false, error: guard.denialMessage ?? 'Captured REPL command denied by policy.' });
        const availability = await probeCapturedExecAvailability();
        await check(signal);
        if (!availability.available) return await finish({
          success: false, error: availability.message,
          output: JSON.stringify({ runtime, result: '', error: availability.message,
            isolated: false, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            captured_exec_availability: availability }),
        });
        let bunRuntimeInput = binding.bunRuntimeInput;
        if (!bunRuntimeInput) {
          try { bunRuntimeInput = await admitRuntime(signal); }
          catch {
            await check(signal);
            return await finish({ success: false, error: 'Captured REPL ordinary Bun runtime is unavailable, changed or access-restricted. Host evaluation is unavailable as a fallback.' });
          }
        }
        const result = await runCapturedCommand({ ...binding, bunRuntimeInput }, command, {}, binding.root, TIMEOUT_MS, signal, 'disabled', {});
        await check(signal);
        const error = result.timed_out ? 'Captured REPL evaluation timed out after 10000ms.' : result.stderr;
        return await finish({
          success: result.success,
          ...(result.cancelled ? { cancelled: true } : {}),
          ...(!result.success ? { error: error || HELD } : {}),
          output: JSON.stringify({
            runtime, result: result.stdout, error: error || undefined,
            isolated: result.sandboxed === true, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            ...(result.captured_exec_availability ? { captured_exec_availability: result.captured_exec_availability } : {}),
          }),
        }, {
          ...(result.sandboxed ? { backend: 'linux-bwrap-projection', launchSummary: `Fresh contained ${runtime} evaluation` } : {}),
          result: result.stdout || undefined, error: error || undefined,
        });
      } catch {
        return { success: false, error: HELD, ...(signal?.aborted ? { cancelled: true } : {}) };
      }
    },
  };
  tools.set(tool, binding.authority);
  return tool;
}
