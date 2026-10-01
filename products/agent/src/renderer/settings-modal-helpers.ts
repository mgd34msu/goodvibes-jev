/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry, McpEntry, SubscriptionEntry } from '../input/settings-modal.ts';
import type { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';
import { isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import { activeTokens } from './theme.ts';

function maskSecretValue(value: string): string {
  if (value.length === 0) return '(empty)';
  if (isSecretReferenceValue(value)) return value;
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-4)}`;
}

export function formatValue(entry: SettingEntry): string {
  const val = entry.currentValue;
  if (val === null || val === undefined) return '(unset)';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string' && isSecretConfigKey(entry.setting.key)) return maskSecretValue(val);
  if (typeof val === 'string' && val === '') return '(empty)';
  return String(val);
}

// Row colours come from the active theme: the accent marks modified or active
// values, status tokens mark risk, and neutral values read muted.
export function valueColor(entry: SettingEntry): string {
  if (!entry.isDefault) return activeTokens().accent; // modified
  return activeTokens().textMuted;                    // default
}

export function flagStateColor(state: string, killed: boolean): string {
  const p = activeTokens();
  if (killed) return p.error;
  if (state === 'enabled') return p.accent;
  return p.textMuted;
}

export function mcpTrustColor(mode: McpEntry['trustMode']): string {
  const p = activeTokens();
  switch (mode) {
    case 'allow-all':
      return p.error;
    case 'ask-on-risk':
      return p.warning;
    case 'constrained':
      return p.accent;
    case 'blocked':
      return p.textMuted;
    default:
      return p.textMuted;
  }
}

export function subscriptionStateColor(state: SubscriptionEntry['state']): string {
  const p = activeTokens();
  switch (state) {
    case 'active':
      return p.accent;
    case 'pending':
      return p.warning;
    case 'available':
      return p.info;
    default:
      return p.textMuted;
  }
}

export function inferSubscriptionRouteReason(entry: SubscriptionEntry): string | undefined {
  if (entry.routeReason?.trim()) return entry.routeReason;
  if (entry.state === 'active' && entry.oauthConfigured) {
    return 'ambient key override enabled for this provider.';
  }
  if (entry.state === 'pending' && entry.oauthConfigured) {
    return 'oauth configuration present; ambient key override will apply after activation.';
  }
  return undefined;
}

export const CATEGORY_LABELS: Record<(typeof SETTINGS_CATEGORIES)[number], string> = {
  display: 'Display',
  ui: 'UI',
  provider: 'Provider',
  subscriptions: 'Subscriptions',
  behavior: 'Behavior',
  profile: 'Your Profile',
  occasions: 'Dates and Plans',
  storage: 'Storage',
  permissions: 'Permissions',
  diagnostics: 'Diagnostics',
  helper: 'Helper',
  tts: 'TTS',
  voice: 'Local Voice',
  automation: 'Automation',
  checkin: 'Check-in',
  service: 'Service',
  controlPlane: 'Control Plane',
  httpListener: 'HTTP Listener',
  danger: 'Danger Zone',
  web: 'Web',
  watchers: 'Watchers',
  network: 'Network',
  relay: 'Relay',
  cluster: 'Cluster',
  orchestration: 'Orchestration',
  fleet: 'Fleet',
  planner: 'Planner',
  daemon: 'Daemon',
  runtime: 'Runtime',
  sandbox: 'Sandbox',
  batch: 'Batch',
  cloudflare: 'Cloudflare',
  wrfc: 'WRFC',
  telemetry: 'Telemetry',
  cache: 'Cache',
  mcp: 'MCP',
  surfaces: 'Channels',
  conversationGate: 'Channel Message Handling',
  hostedSessions: 'Daemon-Hosted Conversations',
  release: 'Update Channel',
  tools: 'Tools',
  flags: 'Feature Controls',
  atRest: 'At-Rest Protection',
  learning: 'Memory Consolidation',
  agents: 'Agent Runtime',
  notifications: 'Notifications',
  policy: 'Policy Bundles',
  fetch: 'Fetch Safety',
  security: 'Token Rotation',
  integrations: 'Delivery Reliability',
  update: 'Daemon Updates',
  pricing: 'Model Pricing',
  power: 'Sleep and Power',
  device: 'Paired Phone Capabilities',
  memory: 'Memory Governance',
  payments: 'Payments',
  email: 'Email Connection',
  calendar: 'Calendar Connections',
  google: 'Google Connection',
};

export const SETTING_LABELS: Partial<Record<string, string>> = {
  'ui.systemMessages': 'System Message Target',
  'ui.operationalMessages': 'Operational Message Target',
  'ui.voiceEnabled': 'Voice Interaction',
  'behavior.autoCompactThreshold': 'Auto-Compact %',
  'behavior.staleContextWarnings': 'Context Warnings',
  'behavior.returnContextMode': 'Return Context',
  'behavior.guidanceMode': 'Guidance Mode',
  'storage.secretPolicy': 'Secret Policy',
  'tools.llmProvider': 'Tool LLM Provider',
  'tools.llmModel': 'Tool LLM Model',
  'tools.autoHeal': 'Auto-Heal',
  'tools.defaultTokenBudget': 'Default Token Budget',
  'tools.hooksFile': 'Hooks File',
  'helper.enabled': 'Helper Enabled',
  'helper.globalProvider': 'Helper Provider',
  'helper.globalModel': 'Helper Model',
  'surfaces.ntfy.enabled': 'ntfy Enabled',
  'surfaces.ntfy.baseUrl': 'ntfy Base URL',
  'surfaces.ntfy.topic': 'ntfy Default Delivery Topic',
  'surfaces.ntfy.chatTopic': 'ntfy Chat Topic',
  'surfaces.ntfy.agentTopic': 'ntfy Agent Topic',
  'surfaces.ntfy.remoteTopic': 'ntfy Runtime-Only Remote Topic',
  'surfaces.ntfy.token': 'ntfy Token',
  'surfaces.ntfy.defaultPriority': 'ntfy Default Priority',
  // Trigger family (stream watchers, condition checks, on-exit process
  // triggers). These live under the existing Watchers category because their
  // keys are `watchers.triggers.*` and the category is the key's first
  // segment; without labels the rows would render as raw sub-paths like
  // "triggers.backoffLadderMs", which reads as noise next to the plain
  // watchers keys they sit beside.
  'watchers.triggers.enabled': 'Triggers Enabled',
  'watchers.triggers.backoffLadderMs': 'Trigger Retry Ladder',
  'watchers.triggers.breakerStrikes': 'Trigger Breaker Strikes',
  'watchers.triggers.defaultCheckIntervalMs': 'Trigger Check Interval',
  'watchers.triggers.probeTimeoutMs': 'Trigger Probe Timeout',
  'watchers.triggers.maxConcurrentChecks': 'Trigger Check Concurrency',
  'watchers.triggers.observationRingSize': 'Trigger Observation History',
  'watchers.triggers.runHistoryLimit': 'Trigger Run History Limit',
  'watchers.triggers.runHistoryTtlHours': 'Trigger Run History TTL',
  'watchers.triggers.eventLogLimit': 'Trigger Event Log Limit',
  'watchers.triggers.eventLogTtlHours': 'Trigger Event Log TTL',
  'watchers.triggers.sweepIntervalMs': 'Trigger Housekeeping Sweep',
  'watchers.triggers.streamQueueLimit': 'Stream Watcher Queue Limit',
  'watchers.triggers.streamBatchLines': 'Stream Watcher Batch Size',
  'watchers.triggers.streamBatchIntervalMs': 'Stream Watcher Batch Interval',
  'watchers.triggers.onExitMaxDurationMs': 'On-Exit Max Duration',
  'watchers.triggers.onExitStdin': 'On-Exit Standard Input',
  'watchers.triggers.outputTailBytes': 'On-Exit Output Tail',
  'payments.enabled': 'Payments Enabled',
  'payments.defaultCardId': 'Default Card ID',
  'payments.currency': 'Currency',
  'payments.cvvHandling': 'CVV Handling',
  'payments.budget.dailyItem': 'Daily Item Budget',
  'payments.budget.dailyOverage': 'Daily Overage Allowance',
  'payments.budget.perPurchaseCeilingEnabled': 'Per-Purchase Ceiling Enabled',
  'payments.budget.perPurchaseCeiling': 'Per-Purchase Ceiling',
  'payments.budget.overageToleranceEnabled': 'Overage Tolerance Enabled',
  'payments.budget.overageToleranceDailyAllowance': 'Overage Tolerance Daily Allowance',
  'payments.shipping.preferredTier': 'Preferred Shipping Tier',
  'payments.windows.vetoMinutes': 'Veto Window (Minutes)',
  'payments.windows.approvalMinutes': 'Approval Window (Minutes)',
  'payments.notifyChannels': 'Notify Channels',
};

export function getSettingLabel(entry: SettingEntry): string {
  return SETTING_LABELS[entry.setting.key] ?? entry.setting.key.replace(/^[^.]+\./, '');
}

export function describeUiRouting(value: string): string {
  switch (value) {
    case 'panel':
      return 'render in the activity feed only';
    case 'conversation':
      return 'render inline in conversation';
    case 'both':
      return 'render in both conversation and the activity feed';
    default:
      return value;
  }
}
