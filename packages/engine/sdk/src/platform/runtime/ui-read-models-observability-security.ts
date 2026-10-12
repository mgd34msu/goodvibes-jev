import { captureMcpSecurityDecisionReadSource } from '../mcp/registry.js';
import { assertSecurityReadSource, captureSecurityReadBindings, retainSecurityReadData, retainSecurityReadMap } from '../security/read-source.js';
import { captureTokenAuditReadSource } from '../security/token-audit.js';
import { capturePolicyRuntimeReadSource } from './permissions/policy-runtime.js';
import { capturePluginSecurityReadSource } from '../plugins/manager.js';
import { captureRuntimeSecurityReadSource } from './store/index.js';
import { captureForensicsReadSource } from './forensics/registry.js';
import { buildMcpAttackPathReview } from './mcp/index.js';
import type { McpDecisionRecord, McpSecuritySnapshot } from './mcp/types.js';
import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { combineSubscriptions } from './ui-read-model-helpers.js';
import type { SecurityPanelSnapshot } from './diagnostics/panels/security.js';
import type { PluginStatus } from '../plugins/manager.js';

export interface UiMcpServerSnapshot {
  readonly name: string;
  readonly role: string;
  readonly trustMode: string;
  readonly status: string;
  readonly schemaFreshness: string;
  readonly toolCount: number;
  readonly lastError?: string | undefined;
  readonly quarantineReason?: string | undefined;
  readonly quarantineDetail?: string | undefined;
}

export interface UiSecuritySnapshot {
  readonly audit: SecurityPanelSnapshot;
  readonly policy: {
    readonly preflightStatus: string;
    readonly preflightIssueCount: number;
    readonly lintFindingCount: number;
  };
  readonly deniedPermissions: number;
  readonly incidents: ReturnType<import('./forensics/index.js').ForensicsRegistry['getAll']>;
  readonly latestIncident: ReturnType<import('./forensics/index.js').ForensicsRegistry['latest']>;
  readonly mcpServers: readonly McpSecuritySnapshot[];
  readonly recentMcpDecisions: readonly McpDecisionRecord[];
  readonly attackPathReview: ReturnType<typeof buildMcpAttackPathReview>;
  readonly plugins: readonly PluginStatus[];
  readonly quarantinedPlugins: readonly PluginStatus[];
  readonly untrustedPlugins: readonly PluginStatus[];
}

export interface UiMcpSnapshot {
  readonly servers: readonly UiMcpServerSnapshot[];
  readonly connectedServerNames: readonly string[];
  readonly availableToolCount: number;
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly recentDecisions: readonly McpDecisionRecord[];
}

export interface UiLocalAuthSnapshot {
  readonly bootstrapCredentialPresent: boolean;
  readonly userCount: number;
  readonly sessionCount: number;
}

export interface UiSecurityObservabilityReadModels {
  readonly security: UiReadModel<UiSecuritySnapshot>;
  readonly mcp: UiReadModel<UiMcpSnapshot>;
  readonly localAuth: UiReadModel<UiLocalAuthSnapshot>;
}

export interface UiSecurityReadSource {
  readonly snapshot: UiSecuritySnapshot;
  readonly assertCurrent: () => void;
}

const securityReadSources = new WeakMap<UiReadModel<UiSecuritySnapshot>, () => UiSecurityReadSource>();
const getSecurityReadSources = securityReadSources.get.bind(securityReadSources);
const setSecurityReadSources = securityReadSources.set.bind(securityReadSources);

/** Only this native factory can supply the original source guard. No effect authority is granted. */
export function captureUiSecurityReadSource(model: UiReadModel<UiSecuritySnapshot>): UiSecurityReadSource {
  const capture = getSecurityReadSources(model);
  assertSecurityReadSource(capture !== undefined);
  return capture();
}

/** Native domain DTOs include owned Maps; retain every descriptor and entry without JSON conversion. */
function captureSecurityDomain(owner: object, mapNames: readonly string[]): () => void {
  captureSecurityReadBindings(owner, [])();
  const keys = Reflect.ownKeys(owner);
  assertSecurityReadSource(keys.every(key => typeof key === 'string'));
  const names = keys.filter((key): key is string => typeof key === 'string');
  const bindings = captureSecurityReadBindings(owner, names);
  const values: unknown[] = [], maps: (() => void)[] = [];
  for (const name of names) {
    const value: unknown = Object.getOwnPropertyDescriptor(owner, name)?.value;
    if (mapNames.includes(name)) {
      assertSecurityReadSource(value instanceof Map);
      maps.push(retainSecurityReadMap(value));
    } else values.push(value);
  }
  const dataCurrent = retainSecurityReadData(values);
  return () => { bindings(); dataCurrent(); for (const guard of maps) guard(); bindings(); };
}

export function createSecurityObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: import('./ui-read-models-observability-options.js').UiObservabilityReadModelOptions = {},
): UiSecurityObservabilityReadModels {
  const { runtimeStore } = runtimeServices;

  const security: UiReadModel<UiSecuritySnapshot> = {
      getSnapshot() {
        const audit = runtimeServices.tokenAuditor.auditAll(Date.now());
        const mcpServers = [...runtimeStore.getState().mcp.servers.values()].map((server): McpSecuritySnapshot => ({
          name: server.name,
          role: server.role,
          trustMode: server.trustMode,
          allowedPaths: server.allowedPaths,
          allowedHosts: server.allowedHosts,
          schemaFreshness: server.schemaFreshness,
          quarantineReason: server.quarantineReason,
          quarantineDetail: server.quarantineDetail,
          connected: server.status === 'connected' || server.status === 'degraded',
        }));
        const recentMcpDecisions = runtimeServices.mcpRegistry.listRecentSecurityDecisions(8);
        const attackPathReview = buildMcpAttackPathReview({
          servers: mcpServers,
          recentDecisions: recentMcpDecisions,
        });
        const plugins = runtimeServices.pluginManager.list();
        const policySnapshot = runtimeServices.policyRuntimeState.getSnapshot();
        const snapshot: SecurityPanelSnapshot = {
          managed: runtimeServices.tokenAuditor.isManaged,
          totalTokens: runtimeServices.tokenAuditor.tokenCount,
          results: audit.results,
          blocked: audit.blocked,
          scopeViolations: audit.scopeViolations,
          rotationWarnings: audit.rotationWarnings,
          rotationOverdue: audit.rotationOverdue,
          lastAuditAt: audit.capturedAt,
          capturedAt: new Date().toISOString(),
        };
        return {
          audit: snapshot,
          policy: {
            preflightStatus: policySnapshot.lastPreflightReview?.status ?? 'n/a',
            preflightIssueCount: policySnapshot.lastPreflightReview?.issueCount ?? 0,
            lintFindingCount: policySnapshot.lintFindings.length,
          },
          deniedPermissions: runtimeStore.getState().permissions.denialCount,
          incidents: options.forensicsRegistry?.getAll() ?? [],
          latestIncident: options.forensicsRegistry?.latest() ?? null,
          mcpServers,
          recentMcpDecisions,
          attackPathReview,
          plugins,
          quarantinedPlugins: plugins.filter((plugin) => plugin.quarantined),
          untrustedPlugins: plugins.filter((plugin) => plugin.trustTier === 'untrusted'),
        };
      },
      subscribe(listener) {
        const unsubs: Array<() => void> = [
          runtimeStore.subscribe(listener),
          runtimeServices.pluginManager.subscribe(listener),
          runtimeServices.policyRuntimeState.subscribe(listener),
        ];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
  };
  setSecurityReadSources(security, () => {
    const modelCurrent = captureSecurityReadBindings(security, ['getSnapshot', 'subscribe']);
    const runtimeCurrent = captureSecurityReadBindings(runtimeServices, ['runtimeStore', 'tokenAuditor', 'pluginManager', 'policyRuntimeState', 'mcpRegistry']);
    const storeCurrent = captureRuntimeSecurityReadSource(runtimeStore);
    const optionsCurrent = captureSecurityReadBindings(options, ['forensicsRegistry']);
    const state = runtimeStore.getState();
    const stateCurrent = captureSecurityReadBindings(state, ['mcp', 'permissions']);
    const mcpCurrent = captureSecurityDomain(state.mcp, ['servers', 'tools']);
    const permissionsCurrent = captureSecurityDomain(state.permissions, ['sessionApprovals']);
    const tokenCurrent = captureTokenAuditReadSource(runtimeServices.tokenAuditor);
    const policy = capturePolicyRuntimeReadSource(runtimeServices.policyRuntimeState);
    const pluginsCurrent = capturePluginSecurityReadSource(runtimeServices.pluginManager);
    const decisionsCurrent = captureMcpSecurityDecisionReadSource(runtimeServices.mcpRegistry);
    const forensicsCurrent = options.forensicsRegistry ? captureForensicsReadSource(options.forensicsRegistry) : undefined;
    const assertNative = () => {
      modelCurrent(); runtimeCurrent(); storeCurrent(); optionsCurrent(); stateCurrent(); mcpCurrent(); permissionsCurrent();
      tokenCurrent(); policy.assertCurrent(); pluginsCurrent(); decisionsCurrent(); forensicsCurrent?.();
      const current = runtimeStore.getState();
      captureSecurityReadBindings(current, ['mcp', 'permissions'])();
      assertSecurityReadSource(current.mcp === state.mcp && current.permissions === state.permissions);
      modelCurrent(); runtimeCurrent(); storeCurrent(); optionsCurrent();
    };
    assertNative();
    const snapshot = security.getSnapshot();
    const snapshotCurrent = retainSecurityReadData(snapshot);
    assertNative();
    return Object.freeze({ snapshot, assertCurrent() { assertNative(); snapshotCurrent(); assertNative(); } });
  });

  return {
    security,
    mcp: {
      getSnapshot() {
        const state = runtimeStore.getState().mcp;
        const servers = [...state.servers.values()]
          .map((server): UiMcpServerSnapshot => ({
            name: server.name,
            role: server.role,
            trustMode: server.trustMode,
            status: server.status,
            schemaFreshness: server.schemaFreshness,
            toolCount: server.toolCount,
            lastError: server.lastError,
            quarantineReason: server.quarantineReason,
            quarantineDetail: server.quarantineDetail,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          servers,
          connectedServerNames: state.connectedServerNames,
          availableToolCount: state.availableToolCount,
          totalCalls: state.totalCalls,
          totalErrors: state.totalErrors,
          recentDecisions: runtimeServices.mcpRegistry.listRecentSecurityDecisions(8),
        };
      },
      subscribe(listener) {
        return runtimeStore.subscribe(listener);
      },
    },
    localAuth: {
      getSnapshot() {
        const snapshot = runtimeServices.localUserAuthManager.inspect();
        return {
          bootstrapCredentialPresent: snapshot.bootstrapCredentialPresent,
          userCount: snapshot.userCount,
          sessionCount: snapshot.sessionCount,
        };
      },
      subscribe() {
        return () => {};
      },
    },
  };
}
