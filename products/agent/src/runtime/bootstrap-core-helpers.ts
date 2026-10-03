/**
 * bootstrap-core-helpers.ts, the pure parts of the interactive bootstrap.
 *
 * Split out of bootstrap-core.ts, which had reached the 800-line cap
 * check-architecture.ts enforces. At the cap the next change to that file is
 * blocked regardless of what it is, so the seam is drawn here: nothing below
 * touches BootstrapCoreState or the composition order, and each function is
 * callable on its own.
 *
 * bootstrap-core.ts re-exports all four names, so every existing importer is
 * unaffected.
 */
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import { RuntimeEventBus } from '@/runtime/index.ts';
import type { SessionEvent } from '@/runtime/index.ts';

export type CompanionMessagePayload = Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>;

/**
 * Registers the webhook notifier for the runtime session.
 *
 * Configures the provided WebhookNotifier with the given URL list, attaches it
 * to the runtime bus so it receives SESSION_NOTIFICATION events, and pushes a
 * detach() cleanup into runtimeUnsubs for shutdown. When webhookUrls is empty
 * this function is a complete no-op.
 */
export function registerWebhookNotifier(
  webhookNotifier: WebhookNotifier,
  webhookUrls: string[],
  runtimeBus: RuntimeEventBus,
  runtimeUnsubs: Array<() => void>,
): void {
  if (webhookUrls.length === 0) return;
  webhookNotifier.setUrls(webhookUrls);
  webhookNotifier.attachToRuntimeBus(runtimeBus);
  runtimeUnsubs.push(() => webhookNotifier.detach());
}

export function companionMessageToOrchestratorInputOptions(
  payload: CompanionMessagePayload,
): OrchestratorUserInputOptions {
  const metadata = payload.metadata;
  const surface = typeof metadata?.surface === 'string' ? metadata.surface : undefined;
  const topic = typeof metadata?.topic === 'string' ? metadata.topic : undefined;

  return {
    origin: {
      source: payload.source,
      messageId: payload.messageId,
      ...(surface ? { surface } : {}),
      ...(topic ? { topic } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

/**
 * Fleet-attention wiring: derive the shared-approval metadata for a
 * permission ask. Background/subagent asks carry
 * `request.attribution` (kind: 'background-agent', agentId, template, set by
 * AgentOrchestrator's gateBackgroundToolCall once permissionManager is wired
 * into it, see the `services.agentOrchestrator.setDependencies(...)` call
 * below and orchestrator.test.ts's "background agent permission gating"
 * suite). Forwarding `attribution.agentId` into the shared approval's
 * `metadata.agentId` is what lets the SDK's fleet ProcessRegistry
 * (runtime/fleet/registry.js, collectPendingApprovals) attribute the pending
 * ask to that agent's ProcessNode, deriving
 * `state: 'awaiting-approval'` / `needsAttention: { reason: 'approval' }` on
 * the spawned agent itself, rather than leaving the ask an anonymous approval
 * entry the fleet plane cannot attach to anything. Foreground asks (no
 * attribution) return undefined, preserving today's un-attributed shape.
 *
 * PermissionAttribution is a discriminated union (SDK 1.6.1 added
 * `mcp-server` and `sandbox-escalation` alongside the original
 * `background-agent`); only `background-agent` carries an `agentId` the
 * fleet ProcessRegistry can attach a pending approval to, so only that kind
 * populates `metadata.agentId` here. The other two kinds are surfaced in the
 * permission-prompt UI itself (see src/permissions/prompt.ts), not through
 * fleet attribution metadata, an MCP server or a sandbox escalation is not
 * a spawned agent's ProcessNode.
 */
export function approvalMetadataForRequest(
  request: Pick<PermissionPromptRequest, 'attribution'>,
): Record<string, unknown> | undefined {
  const attribution = request.attribution;
  return attribution?.kind === 'background-agent' ? { agentId: attribution.agentId } : undefined;
}
