import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { runCapabilityBootCheck } from '../capabilities/capability-boot-check.ts';
import { configValueIsPresent, safeMcpServerPosture, servedOperatorMethodIds } from '../capabilities/capability-sources.ts';
import type { CapabilityIndexReport } from '../capabilities/capability-types.ts';
import type { CommandContext } from '../input/command-registry.ts';

/**
 * Resolves what this agent can actually do, before the first turn.
 *
 * Kept out of bootstrap.ts so the wiring reads as one named act rather than a
 * dozen lines of plumbing in the middle of session startup, and so the sources
 * it draws on, registered tools, MCP posture, served daemon methods, config,
 * are visible in one place.
 */
export function wireCapabilityIndex(input: {
  readonly toolRegistry: ToolRegistry;
  readonly commandContext: CommandContext;
  readonly configManager: unknown;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}): CapabilityIndexReport {
  return runCapabilityBootCheck({
    toolRegistry: input.toolRegistry,
    homeDirectory: input.homeDirectory,
    workingDirectory: input.workingDirectory,
    configValuePresent: (key) => configValueIsPresent(input.configManager, key),
    mcpServers: safeMcpServerPosture(input.commandContext),
    servedOperatorMethodIds: servedOperatorMethodIds(),
  });
}
