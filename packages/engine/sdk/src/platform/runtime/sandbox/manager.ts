import type { ConfigKey } from '../../config/schema.js';
import type {
  SandboxBackendProbe,
  SandboxConfigSnapshot,
  SandboxBundle,
  SandboxEvalIsolationMode,
  SandboxHostStatus,
  SandboxProbe,
  SandboxMcpIsolationMode,
  SandboxPreset,
  SandboxProfile,
  SandboxReview,
  SandboxSession,
  SandboxSessionArtifact,
  SandboxVmBackend,
  SandboxWindowsMode,
} from './types.js';
import { probeSandboxBackends } from './backend.js';

export interface ConfigManagerLike {
  get(key: string): unknown;
}

function readConfigValue<K extends ConfigKey>(
  manager: ConfigManagerLike,
  key: K,
): unknown {
  return manager.get(key);
}

export function isRunningInWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function getSandboxConfigSnapshot(
  manager: ConfigManagerLike,
): SandboxConfigSnapshot {
  return Object.freeze({
    replIsolation: readConfigValue(manager, 'sandbox.replIsolation') as SandboxEvalIsolationMode,
    mcpIsolation: readConfigValue(manager, 'sandbox.mcpIsolation') as SandboxMcpIsolationMode,
    windowsMode: readConfigValue(manager, 'sandbox.windowsMode') as SandboxWindowsMode,
    vmBackend: readConfigValue(manager, 'sandbox.vmBackend') as SandboxVmBackend,
  });
}

export function detectSandboxHostStatus(): SandboxHostStatus {
  const runningInWsl = isRunningInWsl();
  const windows = process.platform === 'win32';
  const secureSandboxReady = false;
  const warnings: string[] = ['The local backend executes host processes and provides no isolation boundary.'];
  if (windows && !runningInWsl) {
    warnings.push('WSL alone does not add isolation to the local backend.');
  }
  return Object.freeze({
    platform: process.platform,
    runningInWsl,
    windows,
    secureSandboxReady,
    recommendedBackend: 'local',
    warnings,
  });
}

export function listSandboxProfiles(
  manager: ConfigManagerLike,
): SandboxProfile[] {
  const config = getSandboxConfigSnapshot(manager);
  const profiles: SandboxProfile[] = [
    {
      id: 'eval-js',
      label: 'JavaScript Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['bounded expression/runtime eval', 'records history and evidence'],
    },
    {
      id: 'eval-ts',
      label: 'TypeScript Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['shares eval sandbox substrate', 'planned typed transpile/eval path'],
    },
    {
      id: 'eval-py',
      label: 'Python Eval',
      kind: 'eval',
      isolation: 'dedicated',
      requiresVm: true,
      notes: ['ephemeral venv', '.pth scan before launch'],
    },
    {
      id: 'eval-sql',
      label: 'SQL Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['policy-scoped query execution', 'read-only by default'],
    },
    {
      id: 'eval-graphql',
      label: 'GraphQL Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['schema-aware request validation', 'endpoint-scoped egress'],
    },
    {
      id: 'mcp-shared',
      label: 'Shared MCP Sandbox',
      kind: 'mcp',
      isolation: 'shared',
      requiresVm: config.mcpIsolation !== 'disabled',
      notes: ['requested policy; local backend provides no isolation'],
    },
    {
      id: 'mcp-per-server',
      label: 'Per-Server MCP Sandbox',
      kind: 'mcp',
      isolation: 'dedicated',
      requiresVm: config.mcpIsolation === 'per-server-vm' || config.mcpIsolation === 'hybrid',
      notes: ['requested policy; local backend provides no isolation'],
    },
  ];
  return profiles.map((profile) => Object.freeze(profile));
}

export function listSandboxPresets(): readonly SandboxPreset[] {
  return [
    Object.freeze({
      id: 'secure-balanced',
      label: 'Secure Balanced',
      summary: 'Requests dedicated REPL and hybrid MCP isolation; unavailable with the local host-process backend.',
      config: {
        replIsolation: 'per-runtime-vm',
        mcpIsolation: 'hybrid',
        windowsMode: 'require-wsl',
        vmBackend: 'local',
      },
      notes: ['requires an isolating backend'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'secure-isolated',
      label: 'Secure Isolated',
      summary: 'Requests dedicated isolation; the local host-process backend cannot provide it.',
      config: {
        replIsolation: 'per-runtime-vm',
        mcpIsolation: 'per-server-vm',
        windowsMode: 'require-wsl',
        vmBackend: 'local',
      },
      notes: ['requires an isolating backend'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'shared-performance',
      label: 'Shared Performance',
      summary: 'Requests shared execution; the local backend provides no sandbox boundary.',
      config: {
        replIsolation: 'shared-vm',
        mcpIsolation: 'shared-vm',
        windowsMode: 'native-basic',
        vmBackend: 'local',
      },
      notes: ['host-process execution is not isolation'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'windows-basic',
      label: 'Windows Basic',
      summary: 'Native Windows host-process execution with isolation unavailable.',
      config: {
        replIsolation: 'shared-vm',
        mcpIsolation: 'disabled',
        windowsMode: 'native-basic',
        vmBackend: 'local',
      },
      notes: ['intended for native Windows without WSL', 'core runtime only; not secure sandbox mode'],
    } satisfies SandboxPreset),
  ] as const;
}

export function getSandboxPreset(id: string): SandboxPreset | null {
  return listSandboxPresets().find((preset) => preset.id === id) ?? null;
}

export function buildSandboxReview(
  manager: ConfigManagerLike,
): SandboxReview {
  return Object.freeze({
    config: getSandboxConfigSnapshot(manager),
    host: detectSandboxHostStatus(),
    profiles: listSandboxProfiles(manager),
    backendProbe: probeSandboxBackends(manager),
  });
}

export function renderSandboxReview(
  manager: ConfigManagerLike,
): string {
  const review = buildSandboxReview(manager);
  return [
    'Sandbox Review',
    `  repl isolation: ${review.config.replIsolation}`,
    `  mcp isolation: ${review.config.mcpIsolation}`,
    `  windows mode: ${review.config.windowsMode}`,
    `  vm backend: ${review.config.vmBackend}`,
    `  resolved backend: ${review.backendProbe?.resolvedBackend ?? 'local'}`,
    `  platform: ${review.host.platform}${review.host.runningInWsl ? ' (WSL)' : ''}`,
    `  secure sandbox mode: ${review.host.secureSandboxReady ? 'available' : 'unavailable on this host'}`,
    ...((review.backendProbe?.warnings ?? []).map((warning) => `  backend warning: ${warning}`)),
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n');
}

export function renderSandboxRecommendation(
  manager: ConfigManagerLike,
): string {
  const review = buildSandboxReview(manager);
  const lines = [
    'Sandbox Recommendation',
    `  current repl isolation: ${review.config.replIsolation}`,
    `  current mcp isolation: ${review.config.mcpIsolation}`,
  ];
  lines.push('  isolation is unavailable with the local backend; requested VM settings cannot create a sandbox boundary.');
  return lines.join('\n');
}

export function renderSandboxProfiles(
  manager: ConfigManagerLike,
): string {
  const profiles = listSandboxProfiles(manager);
  return [
    'Requested Sandbox Profiles (local backend does not provide isolation)',
    ...profiles.map((profile) => (
      `  ${profile.id}  [${profile.kind}/${profile.isolation}]  vm=${profile.requiresVm ? 'yes' : 'no'}  ${profile.label}`
    )),
  ].join('\n');
}

export function renderSandboxPresets(): string {
  return [
    'Sandbox Presets',
    ...listSandboxPresets().map((preset) => (
      `  ${preset.id}  ${preset.label}  repl=${preset.config.replIsolation}  mcp=${preset.config.mcpIsolation}  windows=${preset.config.windowsMode}  backend=${preset.config.vmBackend}`
    )),
  ].join('\n');
}

export function inspectSandboxProbe(probe: SandboxProbe): string {
  return [
    'Sandbox Probe',
    `  checkedAt: ${new Date(probe.checkedAt).toISOString()}`,
    `  host: ${probe.host}`,
    `  backend: ${probe.currentBackend}`,
    `  repl isolation: ${probe.replIsolation}`,
    `  mcp isolation: ${probe.mcpIsolation}`,
    `  windows mode: ${probe.windowsMode}`,
    `  secure sandbox: ${probe.secureSandboxReady ? 'ready' : 'not ready'}`,
    `  next: ${probe.recommendedCommand}`,
  ].join('\n');
}

export function inspectSandboxBundle(bundle: SandboxBundle): string {
  return [
    'Sandbox Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  reviewText: ${bundle.review.reviewText.length} chars`,
    `  recommendationText: ${bundle.review.recommendationText.length} chars`,
    `  profilesText: ${bundle.review.profilesText.length} chars`,
  ].join('\n');
}

export function renderSandboxSessions(sessions: readonly SandboxSession[]): string {
  return [
    'Sandbox Sessions',
    ...(sessions.length > 0
      ? sessions.flatMap((session) => {
        const lines = [
          `  ${session.id}  ${session.profileId}  ${session.state}  ${session.shared ? 'shared' : 'dedicated'}  ${session.backend}  ${session.label}${session.startupStatus ? `  startup=${session.startupStatus}` : ''}`,
        ];
        if (session.lastCommandSummary) {
          lines.push(`    last: ${session.lastCommandSummary}`);
        }
        return lines;
      })
      : ['  No active sandbox sessions.']),
  ].join('\n');
}

export function inspectSandboxSessionArtifact(artifact: SandboxSessionArtifact): string {
  return [
    'Sandbox Session Artifact',
    `  exportedAt: ${new Date(artifact.exportedAt).toISOString()}`,
    `  session: ${artifact.session.id}`,
    `  profile: ${artifact.session.profileId}`,
    `  state: ${artifact.session.state}`,
    `  backend: ${artifact.session.backend}`,
    `  startup: ${artifact.session.startupStatus ?? 'n/a'}`,
    `  reviewText: ${artifact.reviewText.length} chars`,
  ].join('\n');
}
