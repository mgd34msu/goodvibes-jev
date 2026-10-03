export const AGENT_HARNESS_MODES = [
  'summary', 'modes', 'mode', 'route_decision', 'cli_commands', 'cli_command',
  'ui_surfaces', 'ui_surface', 'open_ui_surface',
  'shortcuts', 'keybindings', 'keybinding', 'run_keybinding', 'set_keybinding', 'reset_keybinding',
  'commands', 'command', 'run_command', 'channels', 'channel', 'channel_setup_guide', 'channel_triage', 'channel_deliveries', 'notifications', 'notification_target',
  'provider_accounts', 'provider_account', 'mcp_servers', 'mcp_server',
  'setup_posture', 'setup_item', 'setup_repair', 'setup_checkpoint', 'mark_setup_checkpoint', 'clear_setup_checkpoint', 'provision_connected_host_token', 'run_setup_smoke',
  'project_context', 'project_context_file', 'prompt_context',
  'agent_orchestration', 'agent_orchestration_agent',
  'model_routing', 'model_route', 'run_local_model_smoke',
  'execution_posture', 'execution_route', 'browser_control_route',
  'background_processes', 'background_process', 'run_background_process',
  'execution_history', 'execution_history_item',
  'file_recovery', 'run_file_recovery',
  'personal_ops_briefing', 'personal_ops', 'personal_ops_queue', 'personal_ops_intake', 'personal_ops_lane', 'run_personal_ops_read',
  'memory_posture', 'memory_provider', 'memory_refinement', 'run_memory_refinement',
  'autonomy_intake', 'autonomy_queue', 'autonomy_queue_item',
  'learning_curator', 'learning_candidate', 'learning_auto_promote',
  'research_briefing', 'research_workflow', 'research_runs', 'research_run',
  'research_queue', 'research_source',
  'document_ops', 'document_ops_lane',
  'pairing_posture', 'pairing_route',
  'delegation_posture', 'delegation_route',
  'security_posture', 'security_finding', 'policy_explain', 'support_bundles', 'support_bundle',
  'media_posture', 'media_provider',
  'sessions', 'session',
  'settings', 'get_setting', 'set_setting',
  'reset_setting', 'workspace', 'workspace_categories', 'workspace_actions',
  'workspace_action', 'run_workspace_action', 'tools', 'tool', 'release_evidence', 'release_evidence_artifact',
  'release_readiness', 'release_readiness_item',
  'operator_methods', 'operator_method',
  'service_posture', 'service_endpoint',
  'connected_host', 'connected_host_status', 'connected_host_capability',
  'daemon', 'daemon_status',
  'propose_skill_drafts',
  'remote_snapshot', 'remote_peers', 'remote_work', 'remote_pair_requests',
  'remote_pair_approve', 'remote_pair_reject', 'remote_peers_invoke', 'remote_work_cancel',
  'unified_inbox',
  'channel_drafts', 'channel_draft_save', 'channel_draft_send',
  'channel_routing', 'channel_routing_assign', 'channel_routing_remove',
] as const;

const BACKGROUND_PROCESS_ACTION_VALUES = [
  'start', 'spawn', 'run', 'stop', 'kill', 'cancel', 'wait', 'list',
  'status', 'poll', 'log', 'output', 'write', 'capabilities', 'doctor', 'parity',
] as const;

const KEY_COMBO_PARAMETER_SCHEMA = {
  type: 'object',
  properties: { key: { type: 'string' }, ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' } },
  required: ['key'],
  additionalProperties: false,
} as const;

export const AGENT_HARNESS_PARAMETER_PROPERTIES = {
  // The full mode catalog is intentionally NOT inlined as an enum:
  // it would bloat every model prompt. Dispatch still validates against
  // AGENT_HARNESS_MODES and unknown modes return suggestions.
  mode: {
    type: 'string',
    description: 'Operation. Start with "summary"; mode:"modes" lists the catalog.',
  },
  query: {
    type: 'string',
    description: 'Catalog search text or single-item lookup text.',
  },
  command: {
    type: 'string',
    description: 'Slash command string, or CLI command string in cli_command mode.',
  },
  cliCommand: {
    type: 'string',
    description: 'Top-level CLI command string for cli_command inspection.',
  },
  commandName: {
    type: 'string',
    description: 'Slash command root or top-level CLI command token.',
  },
  args: {
    type: 'array',
    items: { type: 'string' },
    description: 'Arguments for run_command when commandName is used.',
  },
  channelId: {
    type: 'string',
    description: 'Channel id for channel mode.',
  },
  notificationTargetId: {
    type: 'string',
    description: 'Notification target id for notification_target mode.',
  },
  providerId: {
    type: 'string',
    description: 'Provider id for provider_account mode.',
  },
  mcpServerId: {
    type: 'string',
    description: 'MCP server id for mcp_server mode.',
  },
  setupItemId: {
    type: 'string',
    description: 'Setup item id for setup_item mode.',
  },
  contextFileId: {
    type: 'string',
    description: 'Project context file id for project_context_file mode.',
  },
  receiptId: {
    type: 'string',
    description: 'Prompt-context receipt id for prompt_context drill-in.',
  },
  turnId: {
    type: 'string',
    description: 'Prompt-context turn id for prompt_context receipt filtering.',
  },
  outcomeStatus: {
    type: 'string',
    enum: ['completed', 'error', 'cancelled', 'pending'],
    description: 'Prompt-context receipt outcome filter.',
  },
  agentId: {
    type: 'string',
    description: 'Visible Agent id for agent_orchestration_agent mode.',
  },
  modelRouteId: {
    type: 'string',
    description: 'Model route, model key, or local endpoint id.',
  },
  executionRouteId: {
    type: 'string',
    description: 'Execution route id for execution_route mode.',
  },
  executionRecordId: {
    type: 'string',
    description: 'Execution history record id for execution_history_item mode.',
  },
  processId: {
    type: 'string',
    description: 'Background process id for process inspect or lifecycle modes.',
  },
  processSessionId: {
    type: 'string',
    description: 'Process session id alias for background process modes.',
  },
  processAction: {
    type: 'string',
    enum: BACKGROUND_PROCESS_ACTION_VALUES,
    description: 'Background process lifecycle action or process-style alias.',
  },
  action: {
    type: 'string',
    enum: BACKGROUND_PROCESS_ACTION_VALUES,
    description: 'Process-style action alias for run_background_process.',
  },
  cwd: {
    type: 'string',
    description: 'Workspace-relative cwd for a background process start.',
  },
  timeoutMs: {
    type: 'number',
    description: 'Timeout for process waits or local model smoke probes.',
  },
  pty: {
    type: 'boolean',
    description: 'Request PTY mode; currently reports unsupported.',
  },
  data: {
    type: 'string',
    description: 'Input data for process write; currently reports unsupported.',
  },
  recoveryAction: {
    type: 'string',
    enum: ['undo', 'redo'],
    description: 'File recovery action for run_file_recovery mode.',
  },
  laneId: {
    type: 'string',
    description: 'Lane id for personal_ops_lane or document_ops_lane mode.',
  },
  queueItemId: {
    type: 'string',
    description: 'Queue item id for autonomy_queue_item mode.',
  },
  candidateId: {
    type: 'string',
    description: 'Candidate id for learning_candidate mode.',
  },
  sourceId: {
    type: 'string',
    description: 'Research source id for research_source mode.',
  },
  runId: {
    type: 'string',
    description: 'Research run id for research_run mode.',
  },
  pairingRouteId: {
    type: 'string',
    description: 'Pairing route id for pairing_route mode.',
  },
  delegationRouteId: {
    type: 'string',
    description: 'Delegation route id for delegation_route mode.',
  },
  findingId: {
    type: 'string',
    description: 'Security finding id for security_finding mode.',
  },
  bundlePath: {
    type: 'string',
    description: 'Workspace-relative bundle JSON path for support_bundle mode.',
  },
  mediaProviderId: {
    type: 'string',
    description: 'Voice or media provider id for media_provider mode.',
  },
  sessionId: {
    type: 'string',
    description: 'Saved session id, or process session id in process modes.',
  },
  session_id: {
    type: 'string',
    description: 'Snake-case process session id alias.',
  },
  categoryId: {
    type: 'string',
    description: 'Workspace category id.',
  },
  surfaceId: {
    type: 'string',
    description: 'UI surface id for ui_surface or open_ui_surface modes.',
  },
  actionId: {
    type: 'string',
    description: 'Workspace action id or keybinding action id.',
  },
  fields: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Editor field values for run_workspace_action.',
  },
  combo: {
    ...KEY_COMBO_PARAMETER_SCHEMA,
    description: 'Single key combo for set_keybinding.',
  },
  combos: {
    type: 'array',
    items: KEY_COMBO_PARAMETER_SCHEMA,
    description: 'Multiple key combos for set_keybinding.',
  },
  recordId: {
    type: 'string',
    description: 'Selected Agent-local record id.',
  },
  knowledgeSpaceId: {
    type: 'string',
    description: 'Agent Knowledge space id for memory_refinement or run_memory_refinement.',
  },
  sourceIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Agent Knowledge source ids for scoped semantic refinement.',
  },
  gapIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Agent Knowledge semantic gap ids for scoped refinement.',
  },
  maxRunMs: {
    type: 'number',
    description: 'Maximum semantic refinement run budget in milliseconds.',
  },
  force: {
    type: 'boolean',
    description: 'Force semantic refinement reprocessing where supported.',
  },
  key: {
    type: 'string',
    description: 'Agent setting key.',
  },
  value: {
    anyOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
    ],
    description: 'Setting value, or visible search text for shortcut routes.',
  },
  target: {
    type: 'string',
    description: 'Generic lookup target for single-item modes.',
  },
  methodId: {
    type: 'string',
    description: 'Public operator or Agent Knowledge method id.',
  },
  endpointId: {
    type: 'string',
    description: 'Connected service endpoint id.',
  },
  artifactId: {
    type: 'string',
    description: 'Release evidence artifact id.',
  },
  itemId: {
    type: 'string',
    description: 'Release readiness item id for mode release_readiness_item.',
  },
  capabilityId: {
    type: 'string',
    description: 'Connected-host capability id.',
  },
  toolName: {
    type: 'string',
    description: 'First-class model tool name.',
  },
  tool: {
    type: 'string',
    description: 'Alias for toolName in policy_explain mode.',
  },
  toolArgs: {
    type: 'object',
    description: 'Model tool arguments for policy_explain mode.',
  },
  category: {
    type: 'string',
    description: 'Setting category filter.',
  },
  prefix: {
    type: 'string',
    description: 'Setting key prefix filter such as surfaces.slack.',
  },
  includeHidden: {
    type: 'boolean',
    description: 'Include hidden settings in settings mode.',
  },
  includeParameters: {
    type: 'boolean',
    description: 'Include optional detail for discovery modes.',
  },
  limit: {
    type: 'number',
    description: 'Maximum catalog entries to return.',
  },
  confirm: {
    type: 'boolean',
    description: 'Required true for confirmed harness effects.',
  },
  explicitUserRequest: {
    type: 'string',
    description: 'User request authorizing a confirmed harness effect.',
  },
  peerId: {
    type: 'string',
    description: 'Remote peer id for remote_peers_invoke or remote_peers_disconnect.',
  },
  requestId: {
    type: 'string',
    description: 'Pair request id for remote_pair_approve or remote_pair_reject.',
  },
  workId: {
    type: 'string',
    description: 'Remote work item id for remote_work_cancel.',
  },
  payload: {
    type: 'object',
    description: 'Command payload for remote_peers_invoke.',
  },
  note: {
    type: 'string',
    description: 'Optional note for remote pair request approve/reject.',
  },
  reason: {
    type: 'string',
    description: 'Optional cancellation reason for remote_work_cancel.',
  },
  draftId: {
    type: 'string',
    description: 'Channel draft id for channel_drafts, channel_draft_send.',
  },
  draftStatus: {
    type: 'string',
    enum: ['draft', 'queued', 'sent', 'failed'],
    description: 'Status filter for channel_drafts list.',
  },
  draftTitle: {
    type: 'string',
    description: 'Optional title for channel_draft_save.',
  },
  draftMessage: {
    type: 'string',
    description: 'Message body for channel_draft_save.',
  },
  draftChannel: {
    type: 'string',
    description: 'Channel target for channel_draft_save.',
  },
  draftRoute: {
    type: 'string',
    description: 'Route id for channel_draft_save or channel_routing_remove.',
  },
  draftWebhook: {
    type: 'string',
    description: 'Webhook URL for channel_draft_save.',
  },
  draftLink: {
    type: 'string',
    description: 'Link target for channel_draft_save.',
  },
  draftTags: {
    type: 'array',
    items: { type: 'string' },
    description: 'Tags for channel_draft_save.',
  },
  surfaceKind: {
    type: 'string',
    description: 'Channel surface kind for channel_routing or channel_routing_assign.',
  },
  profileId: {
    type: 'string',
    description: 'Profile id for channel_routing_assign.',
  },
  routeLabel: {
    type: 'string',
    description: 'Optional label for channel_routing_assign.',
  },
} as const;
