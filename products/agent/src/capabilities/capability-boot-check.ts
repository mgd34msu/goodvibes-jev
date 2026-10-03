import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerBuiltinCapabilities } from './builtin-capabilities.ts';
import { resolveCapabilityIndex } from './capability-index.ts';
import { setCapabilitySnapshot } from './capability-snapshot.ts';
import type { ProbeContext } from './capability-probe-runner.ts';
import type { CapabilityIndexReport } from './capability-types.ts';

/**
 * The boot-time capability check.
 *
 * It answers "what can this agent do right now" before the first turn, without
 * doing any of it: no message sent, no browser opened, no page fetched, no
 * money spent. Every check is a read (see capability-probe-runner.ts), so this
 * is safe to run on every startup.
 *
 * Anything it finds configured-but-unreported is a defect in the index, and it
 * is logged plainly here as well as carried into the model's context. The
 * failure this replaces was silent: the agent said no, and nothing anywhere
 * recorded that the ingredients for a yes were sitting on disk.
 */

export interface CapabilityBootCheckInput {
  readonly toolRegistry: ToolRegistry;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  /** Answers whether a config key holds a value. Never returns the value. */
  readonly configValuePresent: (key: string) => boolean;
  /** Live MCP posture, when this session has an MCP client. */
  readonly mcpServers?: ProbeContext['mcpServers'];
  readonly mcpToolNames?: Iterable<string>;
  /** Operator method ids the daemon actually serves. */
  readonly servedOperatorMethodIds?: Iterable<string>;
}

export function buildProbeContext(input: CapabilityBootCheckInput): ProbeContext {
  let registeredToolNames: ReadonlySet<string>;
  try {
    registeredToolNames = new Set(input.toolRegistry.getToolDefinitions().map((tool) => tool.name));
  } catch {
    registeredToolNames = new Set();
  }
  return {
    registeredToolNames,
    mcpServers: input.mcpServers ?? [],
    mcpToolNames: new Set(input.mcpToolNames ?? []),
    servedOperatorMethodIds: new Set(input.servedOperatorMethodIds ?? []),
    configValuePresent: input.configValuePresent,
  };
}

export function runCapabilityBootCheck(input: CapabilityBootCheckInput): CapabilityIndexReport {
  registerBuiltinCapabilities({
    homeDirectory: input.homeDirectory,
    workingDirectory: input.workingDirectory,
  });
  const report = resolveCapabilityIndex(buildProbeContext(input), { homeDirectory: input.homeDirectory });
  setCapabilitySnapshot(report);

  for (const disagreement of report.disagreements) {
    // Loud on purpose. A capability the agent will refuse while its service is
    // configured is a defect, and it gets said out loud rather than swallowed.
    logger.warn('capability index disagreement: configured but not usable', {
      capability: disagreement.capabilityId,
      reportedState: disagreement.reportedState,
      evidence: disagreement.evidence.join('; '),
      fix: disagreement.fix,
    });
  }
  return report;
}
