/** One-shot evaluation in the existing captured process boundary. No host eval,
 * shared VM, persistent history or model-selected workspace is available here. */
import {
  assertContractInputAuthority,
  assertContractInputReadAccess,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import type { Tool } from '../../types/tools.js';
import { guardExecCommand } from '../exec/ast-guard.js';
import { probeCapturedExecAvailability, runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { createCapturedExecBunRuntimeAdmission } from '../exec/captured-bun-runtime-input.js';
import { REPL_TOOL_SCHEMA } from './schema.js';

const tools = new WeakMap<Tool, ContractInputAuthority>();
const HELD = 'Captured REPL held: original-owner/view authority is unavailable, changed, cancelled or restricted. Output withheld.';
const MAX_COMMAND_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export function isCapturedReplTool(tool: Tool, authority: ContractInputAuthority): boolean {
  return tools.get(tool) === authority;
}

export function createCapturedReplTool(
  binding: CapturedExecAuthority,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): Tool {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  const admitRuntime = binding.bunRuntimeAdmission ?? createCapturedExecBunRuntimeAdmission(binding);
  const tool: Tool = {
    definition: {
      ...REPL_TOOL_SCHEMA,
      description: 'Evaluate one JavaScript or TypeScript snippet in a fresh contained captured workspace. Bindings are JSON values exposed as globals. Returns printed completion and console output. Each call is stateless (no shared variables or VM); authorized file changes persist only in a mutable member view. Network and ambient host environment are unavailable. History and other runtimes are not supported in captured views.',
      sideEffects: ['exec', 'read_fs', 'write_fs'],
      concurrency: 'serial',
    },
    async execute(args, options) {
      const signal = binding.signal && options?.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal ?? options?.signal;
      const check = async (): Promise<void> => {
        await assertContractInputAuthority(binding.authority, binding.root, signal);
        await assertContractInputReadAccess(binding.authority, binding.readAccessFilter, signal);
      };
      try {
        // Pin model input before the first policy await. Neither caller mutation
        // nor a workspaceRoot property can replace the construction binding.
        args = structuredClone(args);
        await check();
        if (args.mode === 'history') return { success: false, error: 'Captured REPL history is unavailable: evaluations are stateless and do not read or write host session history.' };
        if (args.mode !== 'eval' || typeof args.expression !== 'string' || args.expression.length === 0)
          return { success: false, error: 'Captured REPL requires mode eval and a nonempty expression.' };
        const runtime = args.runtime ?? 'javascript';
        if (runtime !== 'javascript' && runtime !== 'typescript')
          return { success: false, error: 'Captured REPL currently supports only stateless JavaScript and TypeScript evaluation.' };
        if (!process.versions.bun)
          return { success: false, error: 'Captured REPL requires the trusted Bun runtime. Host evaluation is unavailable as a fallback.' };
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
        await check();
        if (!guard.allowed) return { success: false, error: guard.denialMessage ?? 'Captured REPL command denied by policy.' };
        const availability = await probeCapturedExecAvailability();
        await check();
        if (!availability.available) return {
          success: false, error: availability.message,
          output: JSON.stringify({ runtime, result: '', error: availability.message,
            isolated: false, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            captured_exec_availability: availability }),
        };
        let bunRuntimeInput = binding.bunRuntimeInput;
        if (!bunRuntimeInput) {
          try { bunRuntimeInput = await admitRuntime(signal); }
          catch {
            await check();
            return { success: false, error: 'Captured REPL ordinary Bun runtime is unavailable, changed or access-restricted. Host evaluation is unavailable as a fallback.' };
          }
        }
        const result = await runCapturedCommand({ ...binding, bunRuntimeInput }, command, {}, binding.root, TIMEOUT_MS, signal, 'disabled', {});
        await check();
        const error = result.timed_out ? 'Captured REPL evaluation timed out after 10000ms.' : result.stderr;
        return {
          success: result.success,
          ...(result.cancelled ? { cancelled: true } : {}),
          ...(!result.success ? { error: error || HELD } : {}),
          output: JSON.stringify({
            runtime, result: result.stdout, error: error || undefined,
            isolated: result.sandboxed === true, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            ...(result.captured_exec_availability ? { captured_exec_availability: result.captured_exec_availability } : {}),
          }),
        };
      } catch {
        return { success: false, error: HELD, ...(signal?.aborted ? { cancelled: true } : {}) };
      }
    },
  };
  tools.set(tool, binding.authority);
  return tool;
}
