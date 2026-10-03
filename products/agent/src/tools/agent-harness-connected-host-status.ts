import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { inspectCliExternalRuntime, type CliExternalRuntimeSnapshot } from '../cli/external-runtime.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { connectedHostOperatorTokenFingerprint, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import {
  blockedConnectedHostCapabilities,
  connectedHostCapabilityMap,
  connectedHostRouteFamilies,
} from './agent-harness-metadata.ts';

const CONNECTED_HOST_STATUS_TIMEOUT_MS = 1500;

function resolveHomeDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.homeDirectory
    ?? context.platform.configManager.getHomeDirectory()
    ?? '';
}

function resolveWorkingDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.workingDirectory
    ?? context.platform.configManager.getWorkingDirectory()
    ?? '';
}

function connectedHostFindings(
  runtime: CliExternalRuntimeSnapshot,
  tokenUsable: boolean,
): readonly Record<string, unknown>[] {
  const findings: Record<string, unknown>[] = [];

  if (!runtime.reachable) {
    findings.push({
      id: 'connected-host-unreachable',
      severity: 'warning',
      summary: 'Connected host is not reachable.',
      cause: runtime.error ?? `No response from ${runtime.baseUrl}.`,
      action: 'Start or repair the owning GoodVibes host outside Agent, then recheck connected-host status.',
    });
  } else if (!runtime.compatible) {
    findings.push({
      id: 'connected-host-incompatible',
      severity: 'warning',
      summary: 'Connected host compatibility does not satisfy Agent readiness.',
      cause: 'Connected host is reachable, but at least one public Agent route is unavailable or incompatible.',
      action: 'Update the owning GoodVibes host so its public Agent routes are compatible.',
    });
  }

  if (!tokenUsable) {
    findings.push({
      id: 'connected-host-token-missing',
      severity: 'warning',
      summary: 'Connected-host operator token is missing or unreadable.',
      cause: `No usable operator token was found at ${runtime.operatorToken.path}.`,
      action: 'Provision or repair connected-host access through the owning GoodVibes host.',
    });
  }

  if (runtime.reachable && tokenUsable && !runtime.agentKnowledge.ready) {
    findings.push({
      id: 'agent-knowledge-route-not-ready',
      severity: 'warning',
      summary: 'Isolated Agent Knowledge route is not ready.',
      cause: `${runtime.agentKnowledge.route} returned ${runtime.agentKnowledge.kind}${runtime.agentKnowledge.statusCode === null ? '' : ` (${runtime.agentKnowledge.statusCode})`}.`,
      action: 'Update or repair the connected host, then recheck Agent Knowledge compatibility.',
    });
  }

  return findings;
}

export async function connectedHostStatusSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  options: { readonly includeParameters?: boolean } = {},
): Promise<Record<string, unknown>> {
  const homeDirectory = resolveHomeDirectory(context);
  const workingDirectory = resolveWorkingDirectory(context);
  const token = readConnectedHostOperatorToken(homeDirectory);
  const runtime = await inspectCliExternalRuntime({
    configManager: context.platform.configManager,
    homeDirectory,
    timeoutMs: CONNECTED_HOST_STATUS_TIMEOUT_MS,
  });
  const tokenUsable = Boolean(token.token);

  return {
    ownership: 'external-connected-host',
    readOnly: true,
    modelRoute: 'host action:"status" or action:"services"',
    compatibilityRoutes: {
      modelRoute: 'agent_harness mode:"connected_host_status" or mode:"service_posture"',
    },
    timeoutMs: CONNECTED_HOST_STATUS_TIMEOUT_MS,
    lifecycle: 'GoodVibes Agent can inspect daemon readiness and use confirmed operator methods for supported lifecycle/listener changes.',
    paths: {
      workingDirectory,
      homeDirectory,
    },
    endpoints: {
      controlPlane: {
        enabled: context.platform.configManager.get('controlPlane.enabled'),
        ...resolveRuntimeEndpointBinding(context.platform.configManager, 'controlPlane'),
      },
      httpListener: {
        enabled: context.platform.configManager.get('danger.httpListener'),
        ...resolveRuntimeEndpointBinding(context.platform.configManager, 'httpListener'),
      },
      web: {
        enabled: context.platform.configManager.get('web.enabled'),
        ...resolveRuntimeEndpointBinding(context.platform.configManager, 'web'),
      },
    },
    operatorToken: {
      present: token.present,
      usable: tokenUsable,
      path: token.path,
      fingerprint: token.token ? `sha256:${connectedHostOperatorTokenFingerprint(token.token)}` : null,
      error: token.error ?? null,
    },
    liveStatus: runtime,
    routeReadiness: [
      {
        id: 'status',
        route: '/status',
        reachable: runtime.reachable,
        statusCode: runtime.statusCode,
        compatible: runtime.compatible,
      },
      {
        id: 'agent-knowledge',
        route: runtime.agentKnowledge.route,
        ready: runtime.agentKnowledge.ready,
        kind: runtime.agentKnowledge.kind,
        statusCode: runtime.agentKnowledge.statusCode,
      },
    ],
    findings: connectedHostFindings(runtime, tokenUsable),
    capabilitySummary: {
      routeFamilies: connectedHostRouteFamilies().length,
      availableCapabilities: connectedHostCapabilityMap(toolRegistry).filter((capability) => capability.available === true).length,
      blockedCapabilities: blockedConnectedHostCapabilities().length,
    },
    ...(options.includeParameters ? { modelAccess: {
      diagnostics: 'Use host action:"status" for live readiness, action:"services|service" for endpoint posture, and action:"capabilities|capability" for capability inventory.',
      daemonAliases: 'mode:"daemon_status" is an alias for mode:"connected_host_status"; mode:"daemon" is an alias for mode:"connected_host".',
      lifecycle: 'Use setup or agent_operator_method with confirm:true and explicitUserRequest for supported daemon service methods.',
      cliMirrors: ['goodvibes-agent status --json', 'goodvibes-agent doctor', 'goodvibes-agent compat'],
      tuiMirrors: ['/health', '/compat', 'Agent Workspace -> Connected Host'],
    },
    routeFamilies: connectedHostRouteFamilies(),
    capabilities: connectedHostCapabilityMap(toolRegistry),
    blockedCapabilities: blockedConnectedHostCapabilities() } : {}),
  };
}
