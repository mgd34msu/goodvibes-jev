import { type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import type { CommandContext } from '../input/command-registry.ts';
import {
  buildCliServicePosture,
  type CliServiceEndpointPosture,
  type CliServicePosture,
} from '../cli/service-posture.ts';
import type { RuntimeEndpointId } from '../cli/endpoints.ts';

export interface AgentHarnessServicePostureArgs {
  readonly endpointId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

type ServiceEndpointLookupSource = 'endpointId' | 'target' | 'query';

type ServiceEndpointResolution =
  | { readonly status: 'found'; readonly endpoint: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const SERVICE_ENDPOINT_IDS: readonly RuntimeEndpointId[] = ['controlPlane', 'httpListener', 'web'];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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

function servicePostureRuntime(context: CommandContext) {
  return {
    configManager: context.platform.configManager,
    workingDirectory: resolveWorkingDirectory(context),
    homeDirectory: resolveHomeDirectory(context),
  };
}

function servicePostureOptions(args: AgentHarnessServicePostureArgs) {
  const includeDetails = args.includeParameters === true;
  return {
    probe: includeDetails,
    logTailBytes: includeDetails ? 4096 : 0,
  };
}

function summarizeLog(posture: CliServicePosture, includeTail: boolean): Record<string, unknown> {
  return {
    path: posture.log.path,
    exists: posture.log.exists,
    size: posture.log.size,
    modifiedAt: posture.log.modifiedAt,
    readError: posture.log.readError ?? null,
    ...(includeTail && posture.log.tail !== undefined ? { tail: posture.log.tail } : {}),
  };
}

function describeEndpoint(
  endpoint: CliServiceEndpointPosture,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: endpoint.id,
    label: endpoint.label,
    enabled: endpoint.enabled,
    binding: endpoint.binding,
    bindPosture: endpoint.bindPosture,
    networkFacing: endpoint.networkFacing,
    ...(endpoint.reachable !== undefined ? { reachable: endpoint.reachable } : {}),
    modelRoute: serviceEndpointModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: 'read-only',
        modelOperation: 'Inspect endpoint binding, network-facing posture, and optional reachability only.',
        lifecycle: 'Use setup or confirmed GoodVibes daemon operator methods for service lifecycle/listener changes.',
        settings: 'Use settings action:"list|get" for endpoint settings; raw danger toggles stay protected.',
      },
    } : {}),
  };
}


function serviceEndpointModelRoute(): string {
  return 'host action:"service" or settings action:"get"';
}

function endpointLookupFromArgs(args: AgentHarnessServicePostureArgs): { readonly source: ServiceEndpointLookupSource; readonly input: string } | null {
  const endpointId = readString(args.endpointId);
  if (endpointId) return { source: 'endpointId', input: endpointId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}


async function resolveEndpoint(
  posture: CliServicePosture,
  args: AgentHarnessServicePostureArgs,
  options: { readonly includeParameters?: boolean } = {},
  catalogOptions: CatalogRankingOptions = {},
): Promise<ServiceEndpointResolution> {
  const lookup = endpointLookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'service_endpoint requires endpointId, target, or query. Valid endpoint ids are controlPlane, httpListener, and web.',
    };
  }
  const endpoints = posture.endpoints;
  const normalized = lookup.input.toLowerCase();
  const exact = endpoints.find((endpoint) => endpoint.id === lookup.input);
  if (exact) {
    return { status: 'found', endpoint: describeEndpoint(exact, { includeParameters: options.includeParameters, lookup: { ...lookup, resolvedBy: 'id' } }) };
  }
  const insensitive = endpoints.find((endpoint) => endpoint.id.toLowerCase() === normalized);
  if (insensitive) {
    return { status: 'found', endpoint: describeEndpoint(insensitive, { includeParameters: options.includeParameters, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  }
  const label = endpoints.find((endpoint) => endpoint.label.toLowerCase() === normalized);
  if (label) {
    return { status: 'found', endpoint: describeEndpoint(label, { includeParameters: options.includeParameters, lookup: { ...lookup, resolvedBy: 'label' } }) };
  }
  const selected = await selectHarnessCatalog(endpoints, lookup.input, endpoint => ({ id: endpoint.id, description: endpoint.label, evidence: { endpoint, posture, args } }), catalogOptions, 'agent.service.endpoint');
  catalogOptions.assertCurrent?.();
  if (selected) return { status: 'found', endpoint: describeEndpoint(selected, { includeParameters: options.includeParameters, lookup: { ...lookup, resolvedBy: 'search' } }) };
  return {
    status: 'missing_lookup',
    usage: `Unknown service endpoint ${lookup.input}. Valid endpoint ids are controlPlane, httpListener, and web.`,
  };
}

export function servicePostureCatalogStatus(): Record<string, unknown> {
  return {
    modes: ['service_posture', 'service_endpoint'],
    endpointIds: SERVICE_ENDPOINT_IDS,
    readOnly: true,
    lifecycle: 'Service posture is diagnostic; lifecycle/listener changes require setup or confirmed daemon operator methods.',
  };
}

export async function servicePostureSummary(
  context: CommandContext,
  args: AgentHarnessServicePostureArgs,
  options: CatalogRankingOptions = {},
): Promise<Record<string, unknown>> {
  const request = captureStatefulCatalogRequest(context, args, options);
  args = request.input;
  const includeDetails = args.includeParameters === true;
  const posture = await buildCliServicePosture(servicePostureRuntime(context), { ...servicePostureOptions(args), ...request.options });
  request.assertCurrent();
  return {
    ownership: 'goodvibes-daemon',
    readOnly: true,
    lifecycle: 'GoodVibes Agent reports service posture here. Lifecycle/listener changes require setup or confirmed daemon operator methods.',
    modelRoute: serviceEndpointModelRoute(),
    config: posture.config,
    managed: posture.managed,
    endpoints: posture.endpoints.map((endpoint) => describeEndpoint(endpoint, { includeParameters: includeDetails })),
    log: summarizeLog(posture, includeDetails),
    issues: posture.issues,
    ...(includeDetails ? { modelAccess: {
      endpointLookup: 'Use host action:"service" with endpointId, target, or query to inspect one endpoint.',
      settings: 'Use settings action:"list" includeHidden:true for endpoint setting descriptors. Host-owned listener settings remain read-only.',
      liveHostStatus: 'Use host action:"status" for token posture and Agent Knowledge route readiness.',
    } } : {}),
  };
}

export async function describeHarnessServiceEndpoint(
  context: CommandContext,
  args: AgentHarnessServicePostureArgs,
  options: CatalogRankingOptions = {},
): Promise<ServiceEndpointResolution> {
  const request = captureStatefulCatalogRequest(context, args, options);
  args = request.input;
  const posture = await buildCliServicePosture(servicePostureRuntime(context), {
    ...servicePostureOptions(args),
    ...request.options,
    probe: true,
  });
  request.assertCurrent();
  const result = await resolveEndpoint(posture, args, { includeParameters: true }, request.options);
  request.assertCurrent();
  return result;
}
