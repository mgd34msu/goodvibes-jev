/**
 * bootstrap-agent-tools.ts, every model-facing tool this build registers, in
 * one place.
 *
 * Split out of bootstrap.ts when that module passed the 800-line ceiling. The
 * seam is the subject: this is the list of what the model can call, which is
 * read far more often than the wiring around it and answers a different
 * question from "how does the runtime come up".
 */
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { ConfigManager } from '../config/index.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { RuntimeServices } from './services.ts';
import { missingConversationalCaptureTools } from './agent-conversational-capture.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { createOccasionsGatewayInvoke } from '../agent/occasions-gateway.ts';
import { createProfileGatewayInvoke } from '../agent/owner-profile-gateway.ts';
import { registerAgentAuditTool } from '../tools/agent-audit-tool.ts';
import { registerAgentAutonomyTool } from '../tools/agent-autonomy-tool.ts';
import { registerAgentCapabilityTool } from '../tools/agent-capability-tool.ts';
import { registerAgentChannelsTool } from '../tools/agent-channels-tool.ts';
import { registerAgentComputerTool } from '../tools/agent-computer-tool.ts';
import { registerAgentContextTool } from '../tools/agent-context-tool.ts';
import { registerAgentDelegationTool } from '../tools/agent-delegation-tool.ts';
import { registerAgentDeviceTool } from '../tools/agent-device-tool.ts';
import { registerAgentExecutionTool } from '../tools/agent-execution-tool.ts';
import { registerAgentHarnessTool } from '../tools/agent-harness-tool.ts';
import { registerAgentHostTool } from '../tools/agent-host-tool.ts';
import { installAgentMcpCallRoute } from '../tools/agent-mcp-call-route.ts';
import { registerAgentMemoryTool } from '../tools/agent-memory-tool.ts';
import { registerAgentModelsTool } from '../tools/agent-models-tool.ts';
import { registerAgentOccasionsTool } from '../tools/agent-occasions-tool.ts';
import { registerAgentPersonalOpsTool } from '../tools/agent-personal-ops-tool.ts';
import { registerAgentProfileTool } from '../tools/agent-profile-tool.ts';
import { registerAgentResearchTool } from '../tools/agent-research-tool.ts';
import { registerAgentRouteTool } from '../tools/agent-route-tool.ts';
import { registerAgentSecurityTool } from '../tools/agent-security-tool.ts';
import { registerAgentSessionsTool } from '../tools/agent-sessions-tool.ts';
import { registerAgentSettingsImportTool } from '../tools/agent-settings-import-tool.ts';
import { registerAgentSettingsTool } from '../tools/agent-settings-tool.ts';
import { registerAgentSetupTool } from '../tools/agent-setup-tool.ts';
import { registerAgentSupportTool } from '../tools/agent-support-tool.ts';
import { registerAgentTerminalProcessTools } from '../tools/agent-terminal-process-tools.ts';
import { registerAgentVibeTool } from '../tools/agent-vibe-tool.ts';
import { registerAgentWorkspaceTool } from '../tools/agent-workspace-tool.ts';
import { compactRegisteredToolDefinitions } from '../tools/tool-definition-compaction.ts';
import { wireCapabilityIndex } from './bootstrap-capability-wiring.ts';
import { registerClientPhoneTool } from '@goodvibes-jev/engine/sdk/platform/runtime/client';

export interface AgentToolRegistrationDeps {
  readonly toolRegistry: ToolRegistry;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly configManager: ConfigManager;
  /**
   * The composed runtime. Typed as the whole RuntimeServices rather than a
   * narrowed structural slice: the slice would be a second declaration of what
   * these tools need, and it drifts the first time one of them starts reading
   * another field.
   */
  readonly services: RuntimeServices;
  /** Read at call time, not at registration time, the id changes per session. */
  readonly getSessionId: () => string;
}

export function registerAgentTools(deps: AgentToolRegistrationDeps): void {
  const { toolRegistry, commandRegistry, commandContext, configManager, services } = deps;
  registerAgentHarnessTool(toolRegistry, commandRegistry, commandContext);
  registerAgentAuditTool(toolRegistry, commandRegistry, commandContext);
  registerAgentAutonomyTool(toolRegistry, commandRegistry, commandContext);
  registerAgentChannelsTool(toolRegistry, commandRegistry, commandContext);
  registerAgentComputerTool(toolRegistry, commandRegistry, commandContext);
  // Lets the agent actually invoke tools on MCP servers it can already see.
  installAgentMcpCallRoute(toolRegistry, commandContext);
  // Resolve what this agent can actually do, before the first turn.
  wireCapabilityIndex({
    toolRegistry,
    commandContext,
    configManager,
    homeDirectory: services.shellPaths.homeDirectory,
    workingDirectory: services.shellPaths.workingDirectory,
  });
  // ...and let the model ask the same question mid-turn, live, instead of
  // reasoning about what it can do from a search over the source tree.
  registerAgentCapabilityTool({ toolRegistry, commandContext, configManager });
  registerAgentContextTool(toolRegistry, commandRegistry, commandContext);
  registerAgentDelegationTool(toolRegistry, commandRegistry, commandContext);
  registerAgentDeviceTool(toolRegistry, commandRegistry, commandContext);
  // Paired-phone capabilities. The TOOL is registered here because the loop that
  // calls it runs here; the RUNTIME behind it, the grants ledger, the capture
  // store, the housekeeping sweeps, the confirmation prompt, every `device.*`
  // gate, is the daemon's, reached over the `devices.*` verbs.
  //
  // It has to be the daemon's: a phone pairs with the daemon, a grant must
  // outlive the terminal window that approved it, and the sweep that reaps a
  // grant whose phone is gone has to run with nobody watching. This process
  // composes no second device-posture runtime writing the same grants ledger
  //, that would be a second-writer hazard, and registers no `devices.*`
  // handlers on a catalog nothing outside this process can call, so the web
  // app's grants surface is served from the daemon, not from here.
  registerClientPhoneTool(toolRegistry, services.devicesClient);
  registerAgentExecutionTool(toolRegistry, commandRegistry, commandContext);
  registerAgentHostTool(toolRegistry, commandRegistry, commandContext);
  registerAgentMemoryTool(toolRegistry, commandRegistry, commandContext);
  registerAgentModelsTool(toolRegistry, commandRegistry, commandContext);
  // Occasions live as lines in the same profile file, and the daemon owns both
  // that file and the machine-written acknowledgement store beside it, so this
  // tool holds no state either. It calls the sixteen `occasions.*` verbs, over
  // the same in-process-then-connected-host invoker the profile tool uses, and
  // it decides nothing: no lead window, no cadence, no quiet hours, no kind.
  // See docs/occasions.md §7 on why a surface that computed any of those would
  // be a second implementation of a daemon rule.
  registerAgentOccasionsTool(toolRegistry, {
    invoke: createOccasionsGatewayInvoke({
      gatewayMethods: services.gatewayMethods,
      configManager,
      homeDirectory: services.shellPaths.homeDirectory,
    }),
  });
  registerAgentPersonalOpsTool(toolRegistry, commandRegistry, commandContext);
  // The owner profile lives in one file at daemon scope and the daemon is its
  // only writer, so this tool holds no state of its own, it calls the nine
  // `profile.*` verbs. The invoker prefers this process's own gateway catalog
  // when it carries the handlers and falls back to the connected host
  // otherwise, so the same tool works whether or not this build embeds them.
  registerAgentProfileTool(toolRegistry, {
    invoke: createProfileGatewayInvoke({
      gatewayMethods: services.gatewayMethods,
      configManager,
      homeDirectory: services.shellPaths.homeDirectory,
    }),
  });
  registerAgentResearchTool(toolRegistry, commandRegistry, commandContext);
  registerAgentRouteTool(toolRegistry, commandContext);
  registerAgentSecurityTool(toolRegistry, commandRegistry, commandContext);
  registerAgentSessionsTool(toolRegistry, commandRegistry, commandContext);
  registerAgentSetupTool(toolRegistry, commandRegistry, commandContext);
  registerAgentSettingsTool(toolRegistry, commandRegistry, commandContext);
  registerAgentSupportTool(toolRegistry, commandRegistry, commandContext);
  registerAgentVibeTool(toolRegistry, commandContext);
  registerAgentWorkspaceTool(toolRegistry, commandRegistry, commandContext);
  registerAgentSettingsImportTool(toolRegistry, commandContext);
  registerAgentTerminalProcessTools(toolRegistry, commandContext);
  // The capture floor, checked once every tool this build registers is in.
  // The operator policy tells every turn that recording what it learns is part
  // of answering; if the tools that do the recording were not registered, that
  // instruction is a promise the run cannot keep, which is exactly how an
  // itinerary got found, answered, and stored nowhere. Reported rather than
  // thrown: a missing capture tool is a degraded Agent, not a reason to refuse
  // to boot one.
  const missingCaptureTools = missingConversationalCaptureTools(
    toolRegistry.list().map((tool) => tool.definition.name),
  );
  if (missingCaptureTools.length > 0) {
    logger.warn('conversational capture tools are not registered; this build cannot record what it learns', {
      missing: missingCaptureTools,
    });
  }
  compactRegisteredToolDefinitions(toolRegistry);
}
