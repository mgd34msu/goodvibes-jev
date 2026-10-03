import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool, ToolSideEffect } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../input/command-registry.ts';
import { mcpServerRecords, mcpToolCaller } from './agent-harness-personal-ops-discovery.ts';

/**
 * The mcp tool's effect mode: actually invoking a tool on a connected server.
 *
 * Before this existed the agent could list MCP servers, list their tools, and
 * read their schemas, and then had no way to call any of them. An MCP server
 * the user installed and trusted was, in practice, decoration. The runtime
 * already exposed callTool; the only place it was wired reached it through a
 * keyword filter that matched mail and calendar tools and nothing else.
 *
 * The gate here is the server's own security posture, evaluated by the MCP
 * registry on every call: connection state, schema quarantine, trust mode, and
 * the server's allowed hosts and paths. Which words appear in a tool's name is
 * not a security property and is not used as one.
 */

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
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function serverNameOf(qualifiedName: string): string {
  const parts = qualifiedName.split(':');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts[1] ?? '' : '';
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
 * The route is added only when the runtime actually publishes a tool caller.
 * When it does not, the call mode is never advertised, the schema keeps
 * telling the truth about what can be invoked instead of offering a mode that
 * returns "unknown mode" when used.
 */
const CANCELLED: unique symbol = Symbol('mcp-call-cancelled');

/** `work`, or CANCELLED as soon as `signal` aborts, whichever comes first. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof CANCELLED> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function installAgentMcpCallRoute(registry: ToolRegistry, context: CommandContext): boolean {
  const tool = registry.list().find((candidate) => candidate.definition.name === 'mcp');
  if (!tool) return false;
  const callTool = mcpToolCaller(context);
  if (!callTool) return false;

  advertiseCallMode(tool);
  const originalExecute = tool.execute.bind(tool);
  tool.definition.sideEffects = [...new Set<ToolSideEffect>([...(tool.definition.sideEffects ?? []), 'network', 'state'])];

  tool.execute = async (args, options) => {
    const input = args as McpCallArgs;
    if (readString(input.mode) !== AGENT_MCP_CALL_MODE) return originalExecute(args, options);

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
    const server = mcpServerRecords(context).find((record) => record.name === serverName);
    if (!server) {
      const known = mcpServerRecords(context).map((record) => record.name);
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

    const signal = options?.signal;
    if (signal?.aborted) return { success: false, error: `mcp call ${qualifiedName} was cancelled before it started.` };
    try {
      // The platform's MCP callTool takes no abort signal, so a cancelled call
      // cannot recall the request it already sent; it stops waiting for it and
      // reports the cancellation instead of holding the turn open.
      const result = await raceAbort(callTool(qualifiedName, readInput(input.input)), signal);
      if (result === CANCELLED) return { success: false, error: `mcp call ${qualifiedName} was cancelled.` };
      return { success: true, output: stringifyResult(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `mcp call ${qualifiedName} failed: ${message}` };
    }
  };
  callRouteInstalled = true;
  return true;
}
