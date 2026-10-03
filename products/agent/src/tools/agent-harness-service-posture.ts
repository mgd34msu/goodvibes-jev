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

function describeEndpointCandidate(endpoint: CliServiceEndpointPosture): Record<string, unknown> {
  return {
    endpointId: endpoint.id,
    label: endpoint.label,
    enabled: endpoint.enabled,
    binding: endpoint.binding,
    modelRoute: serviceEndpointModelRoute(),
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

function endpointSearchText(endpoint: CliServiceEndpointPosture): string {
  return [
    endpoint.id,
    endpoint.label,
    endpoint.binding.hostMode,
    endpoint.binding.configuredHost,
    endpoint.binding.host,
    String(endpoint.binding.port),
    endpoint.bindPosture.kind,
    endpoint.bindPosture.label,
  ].join('\n').toLowerCase();
}

function resolveEndpoint(
  posture: CliServicePosture,
  args: AgentHarnessServicePostureArgs,
  options: { readonly includeParameters?: boolean } = {},
): ServiceEndpointResolution {
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
  const searched = endpoints.filter((endpoint) => endpointSearchText(endpoint).includes(normalized));
  if (searched.length === 1) {
    return { status: 'found', endpoint: describeEndpoint(searched[0]!, { includeParameters: options.includeParameters, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.map(describeEndpointCandidate),
    };
  }
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
): Promise<Record<string, unknown>> {
  const includeDetails = args.includeParameters === true;
  const posture = await buildCliServicePosture(servicePostureRuntime(context), servicePostureOptions(args));
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
): Promise<ServiceEndpointResolution> {
  const posture = await buildCliServicePosture(servicePostureRuntime(context), {
    ...servicePostureOptions(args),
    probe: true,
  });
  return resolveEndpoint(posture, args, { includeParameters: true });
}
