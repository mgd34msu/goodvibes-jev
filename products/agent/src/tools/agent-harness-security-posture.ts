import { existsSync, readFileSync } from 'node:fs';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessSecurityArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly findingId?: unknown;
  readonly bundlePath?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type SecurityFindingSeverity = 'info' | 'warn' | 'blocker';
type SecurityFindingSource = 'token' | 'policy' | 'mcp' | 'plugin' | 'incident';

interface SecurityFinding {
  readonly findingId: string;
  readonly source: SecurityFindingSource;
  readonly severity: SecurityFindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
  readonly route: string;
}

interface SupportBundleRoute {
  readonly bundleType: 'support' | 'auth' | 'trust' | 'subscription' | 'voice';
  readonly defaultPath: string;
  readonly inspectCommand: string;
  readonly exportCommand: string;
  readonly importCommand?: string;
  readonly workspaceActionIds: readonly string[];
}

type SecurityFindingResolution =
  | { readonly status: 'found'; readonly finding: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type SupportBundleResolution =
  | { readonly status: 'found'; readonly bundle: Record<string, unknown> }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const SUPPORT_BUNDLE_ROUTES: readonly SupportBundleRoute[] = [
  {
    bundleType: 'support',
    defaultPath: 'goodvibes-agent-bundle.json',
    inspectCommand: '/bundle inspect <path>',
    exportCommand: '/bundle export [path] --yes',
    importCommand: '/bundle import <path> --yes',
    workspaceActionIds: ['support-bundle-export', 'support-bundle-inspect', 'support-bundle-import'],
  },
  {
    bundleType: 'auth',
    defaultPath: 'auth-review-bundle.json',
    inspectCommand: '/auth bundle inspect <path>',
    exportCommand: '/auth bundle export <path> --yes',
    workspaceActionIds: ['auth-bundle-export', 'auth-bundle-inspect'],
  },
  {
    bundleType: 'trust',
    defaultPath: 'trust-review-bundle.json',
    inspectCommand: '/trust bundle inspect <path>',
    exportCommand: '/trust bundle export <path> --yes',
    workspaceActionIds: ['trust-bundle-export', 'trust-bundle-inspect'],
  },
  {
    bundleType: 'subscription',
    defaultPath: 'subscription-bundle.json',
    inspectCommand: '/subscription bundle inspect <path>',
    exportCommand: '/subscription bundle export <path> --yes',
    workspaceActionIds: ['subscription-bundle-export', 'subscription-bundle-inspect'],
  },
  {
    bundleType: 'voice',
    defaultPath: 'voice-bundle.json',
    inspectCommand: '/voice bundle inspect <path>',
    exportCommand: '/voice bundle export <path> --yes',
    workspaceActionIds: ['voice-bundle-export', 'voice-bundle-inspect'],
  },
];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNestedValue(source: unknown, path: string): unknown {
  let cursor = source;
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function countNestedLeaves(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countNestedLeaves(entry), 0);
  if (typeof value === 'object') return Object.values(value).reduce((total, entry) => total + countNestedLeaves(entry), 0);
  return 1;
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function safeText(value: unknown, fallback = 'n/a'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function severityRank(severity: SecurityFindingSeverity): number {
  if (severity === 'blocker') return 0;
  if (severity === 'warn') return 1;
  return 2;
}

function findingSearchText(finding: SecurityFinding): string {
  return [
    finding.findingId,
    finding.source,
    finding.severity,
    finding.title,
    finding.summary,
    JSON.stringify(finding.detail ?? {}),
  ].join('\n').toLowerCase();
}

function describeFindingCandidate(finding: SecurityFinding): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    source: finding.source,
    severity: finding.severity,
    title: finding.title,
    modelRoute: securityFindingModelRoute(),
  };
}

function securityFindingModelRoute(): string {
  return 'security action:"finding" or workspace action:"run_command"';
}

function supportBundleModelRoute(): string {
  return 'support action:"bundle" or workspace action:"run"';
}

function describeFinding(finding: SecurityFinding, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    source: finding.source,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    route: finding.route,
    modelRoute: securityFindingModelRoute(),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters && finding.detail ? { detail: finding.detail } : {}),
    ...(includeParameters ? {
      policy: {
        effect: 'read-only',
        values: 'Security posture returns counts, labels, policy ids, route names, and redacted bundle summaries only; token values, secret values, and raw config values are never returned.',
        mutation: 'Token rotation, policy changes, MCP trust changes, bundle export/import, auth repair, and voice enable/disable stay explicit confirmation-gated workspace or slash-command flows.',
      },
    } : {}),
  };
}

function buildTokenFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const audit = isRecord(securitySnapshot?.audit) ? securitySnapshot.audit : null;
  const results = readRecordArray(audit?.results);
  return results
    .map((result, index): SecurityFinding | null => {
      const scope = isRecord(result.scope) ? result.scope : {};
      const rotation = isRecord(result.rotation) ? result.rotation : {};
      const label = safeText(result.label, `token-${index + 1}`);
      const scopeOutcome = safeText(scope.outcome);
      const rotationOutcome = safeText(rotation.outcome);
      const blocked = result.blocked === true;
      if (!blocked && scopeOutcome === 'ok' && rotationOutcome === 'ok') return null;
      const severity: SecurityFindingSeverity = blocked || rotationOutcome === 'overdue' ? 'blocker' : 'warn';
      return {
        findingId: `token-${slug(label)}-${index + 1}`,
        source: 'token',
        severity,
        title: `Token ${label}`,
        summary: `Scope ${scopeOutcome}; rotation ${rotationOutcome}; blocked ${blocked ? 'yes' : 'no'}.`,
        route: '/security tokens',
        detail: {
          tokenLabel: label,
          policyId: safeText(scope.policyId),
          scopeOutcome,
          rotationOutcome,
          blocked,
          ...(typeof rotation.dueAt === 'number' ? { dueAt: new Date(rotation.dueAt).toISOString() } : {}),
        },
      };
    })
    .filter((finding): finding is SecurityFinding => finding !== null);
}

function buildPolicyFindings(context: CommandContext): readonly SecurityFinding[] {
  const policySnapshot = context.extensions.policyRuntimeState?.getSnapshot();
  if (!policySnapshot) return [];
  const lintFindings = readRecordArray(policySnapshot.lintFindings);
  const findings = lintFindings.map((finding, index): SecurityFinding => {
    const level = safeText(finding.level ?? finding.severity, 'warn').toLowerCase();
    const severity: SecurityFindingSeverity = level === 'error' || level === 'blocker' ? 'blocker' : level === 'info' ? 'info' : 'warn';
    const rule = safeText(finding.ruleId ?? finding.rule ?? finding.code, `policy-${index + 1}`);
    const message = safeText(finding.message ?? finding.summary ?? finding.reason, 'Policy lint finding');
    return {
      findingId: `policy-${slug(rule)}-${index + 1}`,
      source: 'policy',
      severity,
      title: `Policy ${rule}`,
      summary: message,
      route: '/security review',
      detail: {
        rule,
        message,
        level,
      },
    };
  });
  const preflight = isRecord(policySnapshot.lastPreflightReview) ? policySnapshot.lastPreflightReview : null;
  if (!preflight || safeText(preflight.status, 'ok') === 'ok') return findings;
  return [
    ...findings,
    {
      findingId: 'policy-preflight',
      source: 'policy',
      severity: safeText(preflight.status) === 'blocked' ? 'blocker' : 'warn',
      title: 'Policy preflight',
      summary: `Preflight ${safeText(preflight.status)} with ${safeText(preflight.issueCount, '0')} issue(s).`,
      route: '/security review',
      detail: {
        status: safeText(preflight.status),
        issueCount: typeof preflight.issueCount === 'number' ? preflight.issueCount : 0,
      },
    },
  ];
}

function buildMcpFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const mcpServers = readRecordArray(securitySnapshot?.mcpServers);
  const recentMcpDecisions = readArray(securitySnapshot?.recentMcpDecisions);
  const attackPathReview = isRecord(securitySnapshot?.attackPathReview)
    ? securitySnapshot.attackPathReview
    : buildMcpAttackPathReview({ servers: mcpServers as never, recentDecisions: recentMcpDecisions as never });
  const attackFindings = readRecordArray(attackPathReview.findings).map((finding, index): SecurityFinding => {
    const serverName = safeText(finding.serverName, `server-${index + 1}`);
    const severityRaw = safeText(finding.severity, 'warn').toLowerCase();
    const severity: SecurityFindingSeverity = severityRaw === 'critical' || severityRaw === 'high' || severityRaw === 'blocker' ? 'blocker' : severityRaw === 'info' ? 'info' : 'warn';
    return {
      findingId: `mcp-attack-${slug(serverName)}-${index + 1}`,
      source: 'mcp',
      severity,
      title: `MCP attack path ${serverName}`,
      summary: safeText(finding.reason, 'MCP attack-path finding'),
      route: '/security attack-paths',
      detail: {
        serverName,
        route: safeText(finding.route),
        reason: safeText(finding.reason),
        severity: severityRaw,
      },
    };
  });
  const postureFindings = mcpServers.flatMap((server, index): readonly SecurityFinding[] => {
    const serverName = safeText(server.name, `server-${index + 1}`);
    const findings: SecurityFinding[] = [];
    if (server.schemaFreshness === 'quarantined') {
      findings.push({
        findingId: `mcp-quarantined-${slug(serverName)}`,
        source: 'mcp',
        severity: 'blocker',
        title: `MCP quarantined ${serverName}`,
        summary: safeText(server.quarantineReason, 'Server schema is quarantined.'),
        route: `/mcp repair ${serverName}`,
        detail: {
          serverName,
          trustMode: safeText(server.trustMode),
          role: safeText(server.role),
          quarantineReason: safeText(server.quarantineReason),
          quarantineDetail: safeText(server.quarantineDetail),
        },
      });
    }
    if (server.trustMode === 'allow-all') {
      findings.push({
        findingId: `mcp-allow-all-${slug(serverName)}`,
        source: 'mcp',
        severity: 'warn',
        title: `MCP elevated trust ${serverName}`,
        summary: 'Server is configured with allow-all trust.',
        route: `/mcp review ${serverName}`,
        detail: {
          serverName,
          trustMode: 'allow-all',
          role: safeText(server.role),
        },
      });
    }
    return findings;
  });
  return [...attackFindings, ...postureFindings];
}

function buildPluginFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const plugins = readRecordArray(securitySnapshot?.plugins);
  return plugins
    .filter((plugin) => plugin.quarantined === true || plugin.trustTier === 'untrusted')
    .map((plugin, index): SecurityFinding => {
      const name = safeText(plugin.name, `plugin-${index + 1}`);
      const quarantined = plugin.quarantined === true;
      return {
        findingId: `plugin-${quarantined ? 'quarantined' : 'untrusted'}-${slug(name)}`,
        source: 'plugin',
        severity: quarantined ? 'blocker' : 'warn',
        title: `Plugin ${name}`,
        summary: quarantined ? 'Plugin is quarantined.' : 'Plugin is untrusted.',
        route: '/trust review',
        detail: {
          name,
          version: safeText(plugin.version),
          enabled: plugin.enabled === true,
          active: plugin.active === true,
          trustTier: safeText(plugin.trustTier),
          quarantined,
        },
      };
    });
}

function buildIncidentFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const incidents = readRecordArray(securitySnapshot?.incidents);
  return incidents.slice(0, 20).map((incident, index): SecurityFinding => {
    const id = safeText(incident.id, `incident-${index + 1}`);
    return {
      findingId: `incident-${slug(id)}`,
      source: 'incident',
      severity: 'warn',
      title: `Security incident ${id}`,
      summary: safeText(incident.title ?? incident.summary ?? incident.kind, 'Security incident recorded.'),
      route: '/security review',
      detail: {
        id,
        kind: safeText(incident.kind),
        createdAt: safeText(incident.createdAt ?? incident.capturedAt),
      },
    };
  });
}

function readSecuritySnapshot(context: CommandContext): Record<string, unknown> | null {
  try {
    const snapshot = context.platform.readModels?.security.getSnapshot();
    return isRecord(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function buildSecurityFindings(context: CommandContext): readonly SecurityFinding[] {
  const securitySnapshot = readSecuritySnapshot(context);
  return [
    ...buildTokenFindings(securitySnapshot),
    ...buildPolicyFindings(context),
    ...buildMcpFindings(securitySnapshot),
    ...buildPluginFindings(securitySnapshot),
    ...buildIncidentFindings(securitySnapshot),
  ].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.findingId.localeCompare(b.findingId));
}

function countByString(records: readonly Record<string, unknown>[], key: string, value: string): number {
  return records.filter((record) => record[key] === value).length;
}

export function securityPostureCatalogStatus(context: CommandContext): Record<string, unknown> {
  const securitySnapshot = readSecuritySnapshot(context);
  return {
    modes: ['security_posture', 'security_finding'],
    status: securitySnapshot ? 'available' : 'unavailable',
    findings: securitySnapshot ? buildSecurityFindings(context).length : 0,
    readOnly: true,
  };
}

export async function securityPostureSummary(context: CommandContext, args: AgentHarnessSecurityArgs): Promise<Record<string, unknown>> {
  const securitySnapshot = readSecuritySnapshot(context);
  if (!securitySnapshot) {
    return {
      status: 'unavailable',
      findings: [],
      returned: 0,
      total: 0,
      policy: 'Security read models are unavailable in this Agent context.',
    };
  }
  const audit = isRecord(securitySnapshot.audit) ? securitySnapshot.audit : {};
  const policy = isRecord(securitySnapshot.policy) ? securitySnapshot.policy : {};
  const mcpServers = readRecordArray(securitySnapshot.mcpServers);
  const plugins = readRecordArray(securitySnapshot.plugins);
  const subscriptions = context.platform.subscriptionManager;
  const services = context.platform.serviceRegistry;
  const query = readString(args.query).toLowerCase();
  const findings = buildSecurityFindings(context);
  const filtered = findings
    .filter((finding) => !query || findingSearchText(finding).includes(query))
    .slice(0, readLimit(args.limit, 100));
  let secretRefCount: number | null = null;
  if (args.includeParameters === true && context.platform.secretsManager) {
    try {
      secretRefCount = (await context.platform.secretsManager.list()).length;
    } catch {
      secretRefCount = null;
    }
  }
  return {
    status: 'available',
    summary: {
      tokens: {
        total: typeof audit.totalTokens === 'number' ? audit.totalTokens : readRecordArray(audit.results).length,
        blocked: readArray(audit.blocked).length,
        scopeViolations: readArray(audit.scopeViolations).length,
        rotationWarnings: readArray(audit.rotationWarnings).length,
        rotationOverdue: readArray(audit.rotationOverdue).length,
      },
      policy: {
        preflightStatus: safeText(policy.preflightStatus),
        preflightIssueCount: typeof policy.preflightIssueCount === 'number' ? policy.preflightIssueCount : 0,
        lintFindings: typeof policy.lintFindingCount === 'number' ? policy.lintFindingCount : 0,
        deniedPermissions: typeof securitySnapshot.deniedPermissions === 'number' ? securitySnapshot.deniedPermissions : 0,
      },
      mcp: {
        servers: mcpServers.length,
        quarantined: countByString(mcpServers, 'schemaFreshness', 'quarantined'),
        elevated: countByString(mcpServers, 'trustMode', 'allow-all'),
        attackPathFindings: readRecordArray(isRecord(securitySnapshot.attackPathReview) ? securitySnapshot.attackPathReview.findings : []).length,
      },
      plugins: {
        total: plugins.length,
        quarantined: plugins.filter((plugin) => plugin.quarantined === true).length,
        untrusted: countByString(plugins, 'trustTier', 'untrusted'),
      },
      auth: {
        builtInProviders: listBuiltinSubscriptionProviders().length,
        activeSubscriptions: subscriptions?.list().length ?? 0,
        pendingSubscriptions: subscriptions?.listPending().length ?? 0,
        configuredServices: services ? Object.keys(services.getAll()).length : 0,
        ...(secretRefCount !== null ? { secretRefs: secretRefCount } : {}),
      },
    },
    findings: filtered.map((finding) => describeFinding(finding, args.includeParameters === true)),
    returned: filtered.length,
    total: findings.length,
    policy: 'Read-only security posture. Token rotation, policy changes, MCP trust changes, bundle export/import, auth repair, and voice enable/disable remain confirmation-gated workspace or slash-command flows.',
    ...(args.includeParameters === true ? { modelAccess: {
      reviewCommand: '/security review',
      tokensCommand: '/security tokens',
      attackPathsCommand: '/security attack-paths',
      trustReviewCommand: '/trust review',
      authReviewCommand: '/auth review',
      bundleCatalogMode: 'support_bundles',
      singleFindingMode: 'security_finding',
    } } : {}),
  };
}

export function describeHarnessSecurityFinding(context: CommandContext, args: AgentHarnessSecurityArgs): SecurityFindingResolution {
  const findingId = readString(args.findingId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = findingId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'security_finding requires findingId, target, or query. Use mode:"security_posture" to inspect current finding ids.',
    };
  }
  const findings = buildSecurityFindings(context);
  const exact = findings.find((finding) => finding.findingId === input);
  if (exact) return { status: 'found', finding: describeFinding(exact, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const normalized = input.toLowerCase();
  const insensitive = findings.find((finding) => finding.findingId.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', finding: describeFinding(insensitive, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const searched = findings.filter((finding) => findingSearchText(finding).includes(normalized));
  if (searched.length === 1) return { status: 'found', finding: describeFinding(searched[0]!, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: searched.slice(0, 8).map(describeFindingCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown security finding ${input}. Use mode:"security_posture" to inspect current finding ids.`,
  };
}

function bundleRouteSearchText(route: typeof SUPPORT_BUNDLE_ROUTES[number]): string {
  return [
    route.bundleType,
    route.defaultPath,
    route.inspectCommand,
    route.exportCommand,
    route.importCommand ?? '',
    ...route.workspaceActionIds,
  ].join('\n').toLowerCase();
}

export function supportBundleCatalogStatus(): Record<string, unknown> {
  return {
    modes: ['support_bundles', 'support_bundle'],
    bundleTypes: SUPPORT_BUNDLE_ROUTES.length,
    readOnlyInspection: true,
  };
}

export function supportBundleSummary(args: AgentHarnessSecurityArgs): Record<string, unknown> {
  const query = readString(args.query).toLowerCase();
  const routes = SUPPORT_BUNDLE_ROUTES
    .filter((route) => !query || bundleRouteSearchText(route).includes(query))
    .slice(0, readLimit(args.limit, 100))
    .map((route) => ({
      bundleType: route.bundleType,
      defaultPath: route.defaultPath,
      inspectCommand: route.inspectCommand,
      modelRoute: supportBundleModelRoute(),
      ...(args.includeParameters === true ? {
        exportCommand: route.exportCommand,
        ...(route.importCommand ? { importCommand: route.importCommand } : {}),
        workspaceActionIds: route.workspaceActionIds,
        parameters: {
          bundlePath: 'Workspace-relative path for support_bundle inspection.',
          confirm: 'Required for export/import routes through run_workspace_action or run_command.',
        },
      } : {
        summary: previewHarnessText(`${route.bundleType} bundle inspection route`),
      }),
    }));
  return {
    bundles: routes,
    returned: routes.length,
    total: SUPPORT_BUNDLE_ROUTES.length,
    policy: 'Bundle catalog is read-only. Existing bundle inspection returns counts and redaction metadata only; bundle export/import stays confirmation-gated through workspace actions or slash-command mirrors.',
  };
}

function resolveBundlePath(context: CommandContext, args: AgentHarnessSecurityArgs): string {
  const raw = readString(args.bundlePath) || readString(args.target) || readString(args.query);
  if (!raw) return '';
  return context.workspace.shellPaths?.resolveWorkspacePath(raw) ?? raw;
}

function summarizeBundleType(bundle: Record<string, unknown>): string {
  const type = readString(bundle.type);
  if (type) return type;
  if ('permissionMode' in bundle && 'mcpSummary' in bundle) return 'trust-review';
  if ('externalRuntimeAuth' in bundle) return 'auth-review';
  if ('subscriptions' in bundle && 'provider' in bundle) return 'subscription';
  if ('voice' in bundle || 'tts' in bundle) return 'voice';
  return 'unknown';
}

function timestampForBundle(bundle: Record<string, unknown>): number | null {
  const value = bundle.capturedAt ?? bundle.exportedAt ?? bundle.createdAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizeSupportBundle(path: string, bundle: Record<string, unknown>): Record<string, unknown> {
  const redaction = isRecord(bundle.redaction) ? bundle.redaction : {};
  const diagnostics = isRecord(bundle.diagnostics) ? bundle.diagnostics : {};
  const timestamp = timestampForBundle(bundle);
  const mcpSummary = isRecord(bundle.mcpSummary) ? bundle.mcpSummary : {};
  const pluginSummary = isRecord(bundle.pluginSummary) ? bundle.pluginSummary : {};
  return {
    path,
    type: summarizeBundleType(bundle),
    version: safeText(bundle.version),
    capturedAt: timestamp === null ? null : new Date(timestamp).toISOString(),
    topLevelSections: Object.keys(bundle).filter((key) => key !== 'config' && key !== 'secrets'),
    counts: {
      configValues: countNestedLeaves(bundle.config),
      redactedConfigPaths: readArray(redaction.redactedConfigPaths).length,
      diagnosticSections: Object.keys(diagnostics).length,
      secretRefs: readArray(bundle.secretKeys).length,
      serviceNames: readArray(bundle.serviceNames).length,
      activeSubscriptions: readArray(bundle.activeSubscriptions).length,
      pendingSubscriptions: readArray(bundle.pendingSubscriptions).length,
      providerSnapshots: readArray(readNestedValue(bundle, 'diagnostics.providers')).length,
      mcpServers: typeof mcpSummary.total === 'number' ? mcpSummary.total : 0,
      plugins: typeof pluginSummary.total === 'number' ? pluginSummary.total : 0,
    },
    redaction: {
      sentinelPresent: typeof redaction.sentinel === 'string',
      hasRedactedConfigPaths: readArray(redaction.redactedConfigPaths).length > 0,
    },
    policy: {
      effect: 'read-only',
      values: 'Bundle inspection returns structure, counts, timestamps, and redaction metadata only. Raw config values, token values, and secret payloads are not returned.',
      mutation: 'Bundle export/import remains confirmation-gated through run_workspace_action or run_command.',
    },
  };
}

export function describeHarnessSupportBundle(context: CommandContext, args: AgentHarnessSecurityArgs): SupportBundleResolution {
  const path = resolveBundlePath(context, args);
  if (!path) {
    return {
      status: 'missing_lookup',
      usage: 'support_bundle requires bundlePath, target, or query containing a workspace-relative bundle path. Use mode:"support_bundles" to inspect bundle routes.',
    };
  }
  if (!existsSync(path)) {
    return {
      status: 'missing_lookup',
      usage: `Bundle file not found: ${path}. Use mode:"support_bundles" to inspect bundle export and inspect routes.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    return {
      status: 'missing_lookup',
      usage: `Invalid bundle JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: 'missing_lookup',
      usage: `Invalid bundle JSON at ${path}: expected a JSON object.`,
    };
  }
  return {
    status: 'found',
    bundle: summarizeSupportBundle(path, parsed),
  };
}
