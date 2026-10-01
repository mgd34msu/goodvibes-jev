import type { AgentWorkspaceCategory } from './agent-workspace-types.ts';

export const AGENT_WORKSPACE_HOST_CATEGORY: AgentWorkspaceCategory = {
  id: 'host',
  group: 'OPERATIONS',
  label: 'Connected Host',
  summary: 'Connected-host health, tasks, sessions, channels, and automation.',
  detail: 'Use this workspace to inspect the GoodVibes host surfaces that Agent can see: system health, remote routes, host tasks, sessions, channels, schedules, knowledge, media, MCP, provider auth, support bundles, and telemetry/config posture.',
  actions: [
    { id: 'host-task-filter', label: 'Filter host tasks', detail: 'Open a status/type form for read-only connected-host task filtering.', editorKind: 'task-list-filter', kind: 'editor', safety: 'read-only' },
    { id: 'host-task-show', label: 'Inspect host task', detail: 'Open a task-id form for read-only connected-host task metadata.', editorKind: 'task-show', kind: 'editor', safety: 'read-only' },
    { id: 'host-task-output', label: 'Show task output', detail: 'Open a task-id form for read-only connected-host task output.', editorKind: 'task-output', kind: 'editor', safety: 'read-only' },
    { id: 'host-session-graph', label: 'Session graph', detail: 'Open a read-only form for cross-session graph inspection; graph mutation remains blocked in Agent.', editorKind: 'session-graph', kind: 'editor', safety: 'read-only' },
    { id: 'host-provider-detail', label: 'Provider detail', detail: 'Open a provider-id form for account and provider configuration review.', editorKind: 'provider-inspect', kind: 'editor', safety: 'read-only' },
    { id: 'host-provider-routes', label: 'Provider routes', detail: 'Open a provider-id form for account, subscription, and route inspection.', editorKind: 'provider-routes', kind: 'editor', safety: 'read-only' },
    { id: 'host-provider-repair', label: 'Provider repair guidance', detail: 'Open a provider-id form for read-only provider repair guidance.', editorKind: 'provider-account-repair', kind: 'editor', safety: 'read-only' },
    { id: 'host-auth-detail', label: 'Provider auth detail', detail: 'Open a provider-id form for read-only provider auth inspection.', editorKind: 'auth-show', kind: 'editor', safety: 'read-only' },
    { id: 'host-auth-repair', label: 'Provider auth repair', detail: 'Open a provider-id form for provider auth repair guidance.', editorKind: 'auth-repair', kind: 'editor', safety: 'read-only' },
    { id: 'host-auth-bundle-export', label: 'Export auth bundle', detail: 'Open a confirmed form that exports a redacted provider auth review bundle.', editorKind: 'auth-bundle-export', kind: 'editor', safety: 'safe' },
    { id: 'host-auth-bundle-inspect', label: 'Inspect auth bundle', detail: 'Open a form that inspects a provider auth review bundle before sharing or import.', editorKind: 'auth-bundle-inspect', kind: 'editor', safety: 'read-only' },
    { id: 'host-subscription-bundle-export', label: 'Export subscription bundle', detail: 'Open a confirmed form that exports redacted provider subscription state for review.', editorKind: 'subscription-bundle-export', kind: 'editor', safety: 'safe' },
    { id: 'host-subscription-bundle-inspect', label: 'Inspect subscription bundle', detail: 'Open a form that inspects provider subscription state before sharing.', editorKind: 'subscription-bundle-inspect', kind: 'editor', safety: 'read-only' },
    { id: 'host-support-bundle-export', label: 'Export support bundle', detail: 'Export a redacted Agent support bundle from the Host page.', editorKind: 'support-bundle-export', kind: 'editor', safety: 'safe' },
    { id: 'host-support-bundle-inspect', label: 'Inspect support bundle', detail: 'Inspect a support bundle before import or sharing.', editorKind: 'support-bundle-inspect', kind: 'editor', safety: 'read-only' },
    { id: 'host-support-bundle-import', label: 'Import support bundle', detail: 'Import reviewed, non-redacted config values from a support bundle.', editorKind: 'support-bundle-import', kind: 'editor', safety: 'safe' },
    { id: 'host-safety', label: 'Host mutation policy', detail: 'Agent may inspect connected-host surfaces and run explicit confirmed actions, but does not silently create tasks, send channel messages, mutate auth, or start automation.', kind: 'guidance', safety: 'blocked' },
  ],
};
