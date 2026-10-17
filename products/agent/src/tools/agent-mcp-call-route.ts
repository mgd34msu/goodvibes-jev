import { assertCurrentToolInvocation, assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { McpApi, McpToolSchema } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { isDeepStrictEqual } from 'node:util';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import type { Tool, ToolSideEffect } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../input/command-registry.ts';

type McpCallApi = Pick<McpApi, 'callTool' | 'getToolSchema' | 'listServerSecurity'>;
const applyIntrinsic = Reflect.apply;
type McpCallRouteContext = {
  readonly clients?: { readonly mcpApi?: McpCallApi | undefined } | undefined;
  readonly extensions?: { readonly mcpRegistry?: McpCallApi | undefined } | undefined;
  readonly session?: Pick<CommandContext['session'], 'runtime'> | undefined;
};

/** Actual MCP calls retain recorded invocation, effects, server and schema through native transport. */

export const AGENT_MCP_CALL_MODE = 'call';

/**
 * Whether this process installed the call route. The policy-explanation
 * surface reads it so its account of what mcp can do matches what the tool
 * actually accepts, instead of describing the tool as inspection-only after
 * calling has been wired.
 */
let callRouteInstalled = false;

export function isAgentMcpCallRouteInstalled(): boolean {
  return callRouteInstalled;
}

/** Test seam: restores the uninstalled state between cases. */
export function resetAgentMcpCallRouteForTests(): void {
  callRouteInstalled = false;
}

interface McpCallArgs {
  readonly mode?: unknown;
  readonly qualifiedName?: unknown;
  readonly input?: unknown;
  readonly serverName?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readInput(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  const captured = snapshotJudgmentInput(value, 'mcp');
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw new ToolInputProjectionError('invalid');
  return captured as Record<string, unknown>;
}

function serverNameOf(qualifiedName: string): string {
  const parts = qualifiedName.split(':');
  return parts.length === 3 && parts[0] === 'mcp' && parts[1] && parts[2] ? parts[1] : '';
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return String(result);
  }
}

/** Adds the call mode to the tool's advertised schema, so the model can see it. */
function advertiseCallMode(tool: Tool): void {
  const parameters = tool.definition.parameters;
  const properties = parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
  const bag = properties as Record<string, unknown>;
  const mode = bag.mode;
  if (mode && typeof mode === 'object' && !Array.isArray(mode)) {
    const modeSchema = mode as Record<string, unknown>;
    const values = Array.isArray(modeSchema.enum) ? modeSchema.enum.filter((entry): entry is string => typeof entry === 'string') : [];
    if (!values.includes(AGENT_MCP_CALL_MODE)) {
      modeSchema.enum = [...values, AGENT_MCP_CALL_MODE];
    }
    modeSchema.description = 'servers, tools, schema, resources, security, auth inspect. call runs a tool on a connected server.';
  }
  bag.input = {
    type: 'object',
    description: 'Arguments for mode:"call", shaped by the tool\'s own schema (read it with mode:"schema").',
    additionalProperties: true,
  };
}

/**
 * Installs the call route on the registered mcp tool.
 *
 * Both native schema and call ports must exist before the mode is advertised.
 */
const CANCELLED: unique symbol = Symbol('mcp-call-cancelled');

/** `work`, or CANCELLED as soon as `signal` aborts, whichever comes first. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof CANCELLED> {
  if (!signal) return work;
  if (signal.aborted) {
    // A caller may abort synchronously while starting its promise. Own that
    // promise's eventual rejection even when cancellation has already won.
    void work.then(() => undefined, () => undefined);
    return Promise.resolve(CANCELLED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function installAgentMcpCallRoute(registry: ToolRegistry, context: McpCallRouteContext): boolean {
  const tool = registry.list().find((candidate) => candidate.definition.name === 'mcp');
  if (!tool) return false;
  try {
    captureCatalogMethods(context, ['clients', 'extensions']);
    if (context.clients) captureCatalogMethods(context.clients, ['mcpApi']);
    if (context.extensions) captureCatalogMethods(context.extensions, ['mcpRegistry']);
  } catch { return false; }
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (api) { try { captureCatalogMethods(api, ['callTool', 'getToolSchema', 'listServerSecurity']); } catch { return false; } }
  if (!api || typeof api.callTool !== 'function' || typeof api.getToolSchema !== 'function') return false;

  advertiseCallMode(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.definition.sideEffects = [...new Set<ToolSideEffect>([...(tool.definition.sideEffects ?? []), 'network', 'state'])];

  tool.execute = async (args, options) => {
    let input: McpCallArgs;
    try { input = captureCatalogData(args); }
    catch { return { success: false, error: 'MCP arguments must be plain data properties.' }; }
    if (readString(input.mode) !== AGENT_MCP_CALL_MODE) return originalExecute(args, options);
    let signal: AbortSignal | undefined;
    try {
      if (!assertCurrentToolInvocation(args, options)) return { success: false, error: 'MCP calls require a current recorded tool admission.' };
      signal = options?.signal;
      if (signal?.aborted) return { success: false, error: 'MCP call was cancelled before dispatch.' };
      const qualifiedName = readString(input.qualifiedName);
      if (!qualifiedName) {
        return {
          success: false,
          error: 'mcp mode:"call" needs qualifiedName. List the callable tools with mcp mode:"tools", then pass one of their qualifiedName values.',
        };
      }
      const serverName = serverNameOf(qualifiedName);
      if (!serverName) {
        return {
          success: false,
          error: `"${qualifiedName}" is not a qualified MCP tool name. Use the mcp:<server>:<tool> form reported by mcp mode:"tools".`,
        };
      }

      const guards = [captureCatalogMethods(context, ['clients', 'extensions', 'session']),
        captureCatalogMethods(api, ['callTool', 'getToolSchema', 'listServerSecurity'])];
      if (context.clients) guards.push(captureCatalogMethods(context.clients, ['mcpApi']));
      if (context.extensions) guards.push(captureCatalogMethods(context.extensions, ['mcpRegistry']));
      if (context.session) {
        guards.push(captureCatalogMethods(context.session, ['runtime']));
        if (context.session.runtime) guards.push(captureCatalogMethods(context.session.runtime, ['sessionId']));
      }
      const server = captureCatalogData(api.listServerSecurity()).find((record) => record.name === serverName);
      if (!server) {
        const known = captureCatalogData(api.listServerSecurity()).map((record) => record.name);
        return {
          success: false,
          error: known.length > 0
            ? `No MCP server named "${serverName}". Connected servers: ${known.join(', ')}.`
            : `No MCP server named "${serverName}", and no MCP servers are configured.`,
        };
      }
      if (!server.connected) {
        return { success: false, error: `The MCP server "${serverName}" is not connected, so its tools cannot be called.` };
      }
      if (server.trustMode === 'blocked') {
        return {
          success: false,
          error: `The MCP server "${serverName}" is set to blocked, so its tools cannot be called. Change its trust setting in the MCP surface first.`,
        };
      }

      const callTool = api.callTool, getToolSchema = api.getToolSchema;
      if (!callTool || !getToolSchema) throw new ToolInputProjectionError('unavailable');
      const ownedInput = readInput(input.input);
      const serverSnapshot = captureCatalogData(server);
      // A successful call refreshes the observational cache. Its policy and
      // quarantine state remain authority and are checked independently.
      const { schemaFreshness: _freshness, ...policySnapshot } = serverSnapshot;
      let selectedSchema: McpToolSchema | undefined;
      let schemaSnapshot: McpToolSchema | undefined;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (!assertCurrentToolInvocation(args, options)) throw new ToolInputProjectionError('stale');
        for (const guard of guards) guard();
        if ((context.clients?.mcpApi ?? context.extensions?.mcpRegistry) !== api) throw new ToolInputProjectionError('stale');
        const currentServer = captureCatalogData(api.listServerSecurity()).find((record) => record.name === serverName);
        if (!currentServer || currentServer.schemaFreshness === 'quarantined') throw new ToolInputProjectionError('held');
        const { schemaFreshness: _currentFreshness, ...currentPolicy } = captureCatalogData(currentServer);
        if (!isDeepStrictEqual(currentPolicy, policySnapshot)) throw new ToolInputProjectionError('stale');
        if (selectedSchema && !isDeepStrictEqual(captureCatalogData(selectedSchema), schemaSnapshot)) throw new ToolInputProjectionError('stale');
      };
      assertCurrent();
      const schema = await raceAbort<McpToolSchema | null>(applyIntrinsic(getToolSchema, api, [qualifiedName, { signal, assertCurrent }]), signal);
      assertCurrent();
      if (schema === CANCELLED) return { success: false, error: 'MCP schema reading was cancelled.' };
      if (!schema) throw new ToolInputProjectionError('held');
      selectedSchema = schema; schemaSnapshot = captureCatalogData(schema);
      if (schemaSnapshot.name !== qualifiedName.split(':')[2] || !schemaSnapshot.inputSchema
        || typeof schemaSnapshot.inputSchema !== 'object' || Array.isArray(schemaSnapshot.inputSchema)) throw new ToolInputProjectionError('held');
      const assertEffect = () => {
        assertCurrent();
        if (schemaSnapshot?.annotations?.readOnlyHint !== true && !assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
        if (!assertCurrentToolEffect(args, options, 'send')) throw new ToolInputProjectionError('held');
        assertCurrent();
      };
      assertEffect();
      // The canonical MCP owner repeats this restriction before every initial
      // or resumed transport write, in addition to its own source and policy.
      const result = await raceAbort<unknown>(applyIntrinsic(callTool, api, [qualifiedName, ownedInput,
        { signal, assertCurrent: assertEffect, expectedSchema: selectedSchema }]), signal);
      if (result === CANCELLED) return { success: false, error: 'MCP call was cancelled.' };
      assertEffect();
      const output = stringifyResult(result);
      if (result && typeof result === 'object' && !Array.isArray(result) && 'isError' in result && result.isError === true) {
        return { success: false, output, error: 'The MCP server reported a tool error.' };
      }
      return { success: true, output };
    } catch (error) {
      if (error instanceof ToolInputProjectionError || signal?.aborted) return { success: false, error: 'MCP call held: its recorded source or execution authority is unavailable.' };
      return { success: false, error: 'MCP call failed at the connected server boundary.' };
    }
  };
  callRouteInstalled = true;
  return true;
}
