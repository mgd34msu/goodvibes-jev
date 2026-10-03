/**
 * plugin-composition.ts, what a plugin dropped into the plugin directory gets
 * to register when the host loading it is the daemon.
 *
 * A plugin registers into whatever registries the host hands its loader. Two
 * hosts load a plugin today, the terminal app and this daemon, and neither
 * holds every registry a plugin might want. The design (see
 * goodvibes-tui/docs/decisions/2026-07-30-plugin-registrations-split-verb-side-and-surface-side.md)
 * is: one plugin package, loaded by both hosts, each loading the registrations
 * it can serve and ignoring the rest.
 *
 * This is the daemon's half of that. It serves the three verb-side kinds:
 *
 *   - `registerGatewayMethod` → the catalog this process actually answers from,
 *     because unlike a pure client it runs a DaemonServer.
 *   - `registerChannelPlugin` → the registry that receives inbound channel
 *     traffic and elects a single reader across the cluster.
 *   - `registerDeliveryStrategy` → the router replies leave through.
 *
 * plus the provider-shaped registries the daemon really has (providers, memory
 * embeddings, voice, media, web search), which are neither host's exclusively.
 *
 * The two surface-side kinds are the ones this host cannot serve. The SDK's
 * PluginLoaderDeps has no optional members and its API guards nothing, so a
 * host that passes nothing for a registry does not decline that kind, it
 * throws a TypeError inside the plugin's own init, which the loader catches by
 * dropping THE WHOLE PLUGIN, including the halves this host could have run.
 * "Ignores the rest" therefore has to be a real registry that accepts the
 * registration and goes nowhere.
 *
 * What it must not be is silent. Accepting a registration that reaches nothing,
 * with a cheerful success line, is exactly the failure this module exists to
 * prevent. Both stand-ins below say what they took and that nothing here will
 * run it, naming the plugin, so the same plugin loaded by a surface is visibly
 * where that half happens.
 */
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandRegistryLike, HostSlashCommand } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import type { PluginLoaderDeps } from '@goodvibes-jev/engine/sdk/platform/plugins';
import type { RuntimeServices } from './runtime-services-types.js';

/**
 * A slash-command registry for a process with no prompt to type into.
 *
 * Slash commands are read from a composer and rendered on a screen. The daemon
 * has neither, and the decision doc classifies them surface-side, so this
 * accepts them and says so rather than crashing the load of a plugin whose
 * other half this host does run.
 */
export function createUnservedCommandRegistry(): CommandRegistryLike {
  return {
    register(command: HostSlashCommand): void {
      logger.info('[plugins] slash command registered against the daemon; it runs where there is a prompt to type it into', {
        command: command.name,
      });
    },
    unregister(): void {
      // Nothing was ever held, so nothing is released.
    },
  };
}

/**
 * A tool registry the daemon holds but does not execute from.
 *
 * The runs this daemon hosts build their tools through the agent orchestrator's
 * own registry, not this one, so a plugin tool registered here is cataloged and
 * unhandled. That is the recorded classification, `registerTool` is on the
 * surface-side list, and it was written when the daemon hosted no runs of its
 * own; the round that moves session hosting daemon-side is the one that
 * re-examines it. Until then, a registration here is honest rather than quiet.
 */
export class UnservedToolRegistry extends ToolRegistry {
  override register(tool: Tool): void {
    logger.info('[plugins] tool registered against the daemon; the runs here build their tools elsewhere', {
      tool: tool.definition.name,
    });
    super.register(tool);
  }
}

/**
 * Build the loader dependencies for this host.
 *
 * The delivery router is deliberately the manager's own, the one replies leave
 * through, so a registered strategy is a strategy that sends. Handing over a
 * second router built from the same arguments is how a registration succeeds
 * and reaches nothing, which is the shape this whole seam is about.
 */
export function createDaemonPluginLoaderDeps(services: RuntimeServices): PluginLoaderDeps {
  return {
    runtimeBus: services.runtimeBus,
    // Verb-side: served here.
    gatewayMethods: services.gatewayMethods,
    channelRegistry: services.channelPlugins,
    channelDeliveryRouter: services.deliveryManager.getDeliveryRouter(),
    // Provider-shaped: real registries, neither host's exclusively.
    providerRegistry: services.providerRegistry,
    memoryEmbeddingRegistry: services.memoryEmbeddingRegistry,
    voiceProviderRegistry: services.voiceProviders,
    mediaProviderRegistry: services.mediaProviders,
    webSearchProviderRegistry: services.webSearchProviders,
    // Surface-side: accepted and named, never silently swallowed.
    commandRegistry: createUnservedCommandRegistry(),
    toolRegistry: new UnservedToolRegistry(),
    getPluginConfig: (name: string) => services.pluginManager.getPluginConfig(name),
    isEnabled: (name: string) => services.pluginManager.isEnabled(name),
  };
}
