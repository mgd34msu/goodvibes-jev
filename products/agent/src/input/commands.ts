import type { CommandRegistry } from './command-registry.ts';
import type { CommandContext } from './command-registry.ts';
import { sessionCommand } from './commands/session.ts';
import { recallCommand } from './commands/memory.ts';
import { knowledgeCommand } from './commands/knowledge.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerScheduleRuntimeCommands } from './commands/schedule-runtime.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerProductRuntimeCommands } from './commands/product-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerGuidanceRuntimeCommands } from './commands/guidance-runtime.ts';
import { registerSubscriptionRuntimeCommands } from './commands/subscription-runtime.ts';
import { registerSecurityRuntimeCommands } from './commands/security-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerLocalProviderRuntimeCommands } from './commands/local-provider-runtime.ts';
import { registerNetworkScanRuntimeCommands } from './commands/network-scan-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerProviderAccountsRuntimeCommands } from './commands/provider-accounts-runtime.ts';
import { registerConversationRuntimeCommands } from './commands/conversation-runtime.ts';
import { registerQrcodeRuntimeCommands } from './commands/qrcode-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerTtsRuntimeCommands } from './commands/tts-runtime.ts';
import { registerAgentWorkspaceRuntimeCommands } from './commands/agent-workspace-runtime.ts';
import { registerAgentRuntimeProfileRuntimeCommands } from './commands/agent-runtime-profile-runtime.ts';
import { registerDelegationRuntimeCommands } from './commands/delegation-runtime.ts';
import { registerPersonasRuntimeCommands } from './commands/personas-runtime.ts';
import { registerVibeRuntimeCommands } from './commands/vibe-runtime.ts';
import { registerAgentSkillsRuntimeCommands } from './commands/agent-skills-runtime.ts';
import { registerRoutinesRuntimeCommands } from './commands/routines-runtime.ts';
import { registerChannelsRuntimeCommands } from './commands/channels-runtime.ts';
import { registerBriefRuntimeCommands } from './commands/brief-runtime.ts';
import { registerSupportBundleRuntimeCommands } from './commands/support-bundle-runtime.ts';
import { registerCompatRuntimeCommands } from './commands/compat-runtime.ts';
import { registerOwnerProfileRuntimeCommands } from './commands/owner-profile-runtime.ts';
import { registerOperatorActionRuntimeCommands } from './commands/operator-actions-runtime.ts';
import { registerConnectedHostAdminCommands } from './commands/connected-host-admin-runtime.ts';
import { registerEmailRuntimeCommands } from './commands/email-runtime.ts';
import { registerCalendarRuntimeCommands } from './commands/calendar-runtime.ts';
import { registerGoogleRuntimeCommands } from './commands/google-runtime.ts';
import { registerUpdateCommand } from './commands/update-runtime.ts';
import { registerPaymentCardCommands } from './commands/payment-card-intake.ts';

function registerAgentMemoryCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'memory',
    aliases: ['mem'],
    description: 'Agent-local memory: add, search, review, stale, and delete durable memory records',
    usage: '<list|add|search|queue|review|stale|remove> [args]',
    argsHint: 'list|add|search|queue|review|stale|remove',
    handler: async (args: string[], context: CommandContext): Promise<void> => {
      await recallCommand.handler(args.length === 0 ? ['list'] : args, context);
    },
  });
}

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registerShellCoreCommands(registry);
  registerAgentWorkspaceRuntimeCommands(registry);
  registerBriefRuntimeCommands(registry);
  registerSupportBundleRuntimeCommands(registry);
  registerCompatRuntimeCommands(registry);
  registerOwnerProfileRuntimeCommands(registry);
  registerOperatorActionRuntimeCommands(registry);
  registerConnectedHostAdminCommands(registry);
  registerCalendarRuntimeCommands(registry);
  registerAgentRuntimeProfileRuntimeCommands(registry);
  registerVibeRuntimeCommands(registry);
  registerPersonasRuntimeCommands(registry);
  registerAgentSkillsRuntimeCommands(registry);
  registerRoutinesRuntimeCommands(registry);
  registerChannelsRuntimeCommands(registry);
  registerEmailRuntimeCommands(registry);
  registerGoogleRuntimeCommands(registry);
  registerDelegationRuntimeCommands(registry);
  registerConfigCommand(registry);
  registerOperatorRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  registerProductRuntimeCommands(registry);
  registerPlatformAccessRuntimeCommands(registry);
  registerGuidanceRuntimeCommands(registry);
  registerSubscriptionRuntimeCommands(registry);
  registerSecurityRuntimeCommands(registry);
  registerMcpRuntimeCommands(registry);
  registerExperienceRuntimeCommands(registry);
  registerTasksRuntimeCommands(registry);
  registerLocalProviderRuntimeCommands(registry);
  registerNetworkScanRuntimeCommands(registry);
  registerHealthRuntimeCommands(registry);
  registerStatusRuntimeCommands(registry);
  registerUpdateCommand(registry);
  registerProviderAccountsRuntimeCommands(registry);
  registerConversationRuntimeCommands(registry);
  registerQrcodeRuntimeCommands(registry);
  registerOnboardingRuntimeCommands(registry);
  registerTtsRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerScheduleRuntimeCommands(registry);
  registerSessionContentCommands(registry);
  registerPaymentCardCommands(registry);
  registerAgentMemoryCommand(registry);

  // ── /session ─────────────────────────────────────────────────────────────
  registry.register(sessionCommand);

  // ── /knowledge ───────────────────────────────────────────────────────────
  registry.register(knowledgeCommand);
}
