/**
 * mcp-suggestion-scan.ts, the "you have this MCP server installed, add it to
 * mcp.json" advice, without the boot-time server spawn that used to come with
 * it.
 *
 * The SDK's `scheduleBackgroundMcpDiscovery()` does two unrelated things: it
 * calls `connectAll()`, spawning every configured server the moment the agent
 * launches, and, two seconds later, it scans for INSTALLED-but-unconfigured
 * servers and prints suggestions. The suggestions are useful. The eager spawn
 * is what put `npm exec @playwright/mcp` and a browser aimed at a cloud console
 * into a bare boot's process tree.
 *
 * This is the second half on its own. It starts nothing: `serverNames` reads
 * what is configured without connecting (see mcp-lazy-start.ts), and the scan
 * only looks at the filesystem.
 */

import { scanMcpServers } from '@goodvibes-jev/engine/sdk/platform/discovery';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';

/** How long after boot the scan runs, so it never competes with startup. */
const SCAN_DELAY_MS = 2000;

export interface McpSuggestionScanOptions {
  readonly mcpRegistry: Pick<McpRegistry, 'serverNames'>;
  readonly systemMessageRouter: { low(message: string): void };
  readonly requestRender: () => void;
  readonly shellPaths: Omit<Parameters<typeof scanMcpServers>[0], 'surfaceRoot'>;
  readonly surfaceRoot: string;
}

export interface McpSuggestionScanHandle {
  stop(): void;
}

/**
 * Scan for installed-but-unconfigured MCP servers and suggest them, once.
 *
 * Deliberately does NOT connect to anything, then or later.
 */
export function scheduleMcpSuggestionScanOnFirstUse(
  options: McpSuggestionScanOptions,
): McpSuggestionScanHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    if (stopped) return;
    // Reading configured names starts no server, that is the whole point of
    // keeping this method off the connect-on-use list.
    const registered = new Set(options.mcpRegistry.serverNames);
    void scanMcpServers({ ...options.shellPaths, surfaceRoot: options.surfaceRoot }, registered)
      .then((result) => {
        if (stopped || result.suggestions.length === 0) return;
        for (const suggestion of result.suggestions) {
          options.systemMessageRouter.low(
            `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} `
            + `${(suggestion.args ?? []).join(' ')}). Add it to .goodvibes/mcp.json or `
            + '~/.config/mcp/mcp.json to enable it.',
          );
        }
        options.requestRender();
      })
      .catch((error: unknown) => {
        if (stopped) return;
        logger.warn('MCP auto-discovery scan failed', { error: summarizeError(error) });
      });
  }, SCAN_DELAY_MS);
  // Never hold the event loop open for a suggestion.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop: (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
