/**
 * mcp-lazy-start.ts, MCP servers start when a tool needs one, not at boot.
 *
 * ── What was happening ─────────────────────────────────────────────────────
 *
 * `scheduleBackgroundMcpDiscovery()` calls `mcpRegistry.connectAll()` as its
 * first act, and the agent called it during bootstrap. So every server in
 * `mcp.json` was spawned by simply LAUNCHING the agent, before any prompt,
 * any tool call, or any decision by the person sitting there.
 *
 * On a real machine that meant a bare `goodvibes-agent` boot spawned:
 *
 *   npm exec @playwright/mcp@latest --extension --output-dir /tmp/…
 *   npm exec zen-devtools-mcp@latest --zen-path … --start-url https://console.cloud.google.com/
 *
 * Two browser-automation servers, one of them pointed at a cloud console with
 * a dedicated profile. Nobody asked for browser automation at startup. It is
 * startup cost, it is `npm exec` fetching and running packages on every boot,
 * and a configured start-url is a browser window that can appear on someone's
 * screen because they opened a terminal.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 *
 * The registry is wrapped so the connect happens on FIRST USE and never at
 * boot. The methods that genuinely need a live server, listing tools, reading
 * a schema, calling a tool, connect first and then proceed. Everything else
 * passes straight through and starts nothing.
 *
 * `serverNames` deliberately does NOT trigger a connect: it is what callers ask
 * when they want to know what is CONFIGURED, and making that question spawn
 * processes would rebuild the problem through the back door.
 *
 * The suggestion scan ("discovered server X, add it to mcp.json") moved behind
 * the same gate. It only ever produced advice about servers, so an agent whose
 * session never touches MCP now does none of that work either.
 */

import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/** The config roots `connectAll` reads `mcp.json` from. */
export type McpConfigRoots = Parameters<McpRegistry['connectAll']>[0];

export interface LazyMcpStart {
  /**
   * The registry every consumer should be handed. Identical to the real one
   * except that it starts servers on demand.
   */
  readonly registry: McpRegistry;
  /** Connect now. Single-flighted; safe to call from every gated method. */
  ensureConnected(): Promise<void>;
  /** Whether any server has been started yet. False on a boot nobody used MCP in. */
  isConnected(): boolean;
}

/**
 * The registry methods that cannot answer without a running server.
 *
 * Listed explicitly rather than defaulted-on: a new method added to the registry
 * and forgotten here simply starts nothing, which is the safe direction. The
 * failure mode of guessing the other way is spawning browser automation from a
 * method nobody thought was a trigger.
 *
 * Every entry MUST already return a promise. Gating a synchronous method turns
 * it into an async one and breaks its callers, `listServerSecurity()` returns
 * an array, and gating it made `workspaceMcpServers(...).filter` a TypeError
 * that killed the whole TUI at launch. It is deliberately absent: it reports
 * the security state of servers that are running, and before a connect the
 * honest answer is that none are.
 */
const CONNECT_ON_USE: ReadonlySet<string> = new Set([
  'listAllTools',
  'callTool',
  'getToolSchema',
]);

export function createLazyMcpRegistry(
  registry: McpRegistry,
  roots: McpConfigRoots,
  hooks: {
    /** Runs once, after the first successful connect, the suggestion scan. */
    readonly onFirstConnect?: (() => void) | undefined;
  } = {},
): LazyMcpStart {
  let connecting: Promise<void> | null = null;
  let connected = false;

  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    // Single-flight: a turn that calls three MCP tools at once must start the
    // servers once, not three times.
    connecting ??= registry.connectAll(roots)
      .then(() => {
        connected = true;
        try {
          hooks.onFirstConnect?.();
        } catch (error) {
          logger.debug('[mcp] first-connect hook threw', { error: summarizeError(error) });
        }
      })
      .catch((error: unknown) => {
        // Allow a later attempt: a server that was not installed when the first
        // call happened may be there by the next one.
        connecting = null;
        logger.warn('MCP connect-on-use failed', { error: summarizeError(error) });
      });
    await connecting;
  };

  const proxied = new Proxy(registry, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const name = typeof property === 'string' ? property : '';
      if (!CONNECT_ON_USE.has(name)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return async (...args: unknown[]): Promise<unknown> => {
        await ensureConnected();
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
    set(target, property, value): boolean {
      return Reflect.set(target, property, value, target);
    },
  });

  return {
    registry: proxied,
    ensureConnected,
    isConnected: () => connected,
  };
}
