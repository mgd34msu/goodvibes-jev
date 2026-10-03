/**
 * Friendly tool labels, turn internal tool names into the phrase a person
 * would say. Shown on tool-call lines in the conversation; the raw tool name
 * is still discoverable in the Agent workspace tool catalog.
 */

const TOOL_LABELS: Record<string, string> = {
  // SDK file/shell/web tools
  read: 'Reading files',
  write: 'Writing a file',
  edit: 'Editing a file',
  exec: 'Running a command',
  fetch: 'Fetching a web page',
  web_search: 'Searching the web',
  find: 'Searching files',
  analyze: 'Analyzing code',
  inspect: 'Inspecting files',

  // Agent first-class tools
  personal_ops: 'Checking your inbox & calendar',
  research: 'Researching',
  agent_research_runs: 'Researching',
  agent_research_sources: 'Reviewing sources',
  agent_research_report: 'Writing a research report',
  schedule: 'Checking schedules',
  agent_schedule_edit: 'Updating a schedule',
  agent_autonomy_schedule: 'Scheduling background work',
  agent_reminder_schedule: 'Setting a reminder',
  autonomy: 'Checking background work',
  channels: 'Checking message channels',
  agent_channel_send: 'Sending a message',
  notify: 'Sending a notification',
  memory: 'Recalling memory',
  agent_knowledge: 'Searching knowledge',
  agent_knowledge_ingest: 'Saving to knowledge',
  agent_learning_consolidation: 'Consolidating what I learned',
  agent_local_registry: 'Checking notes & routines',
  models: 'Checking models',
  agent_model_compare: 'Comparing models',
  settings: 'Adjusting settings',
  agent_settings_import: 'Importing settings',
  setup: 'Checking setup',
  security: 'Reviewing safety',
  sessions: 'Looking at past conversations',
  browser: 'Using the browser',
  computer: 'Checking browser and desktop setup',
  device: 'Checking this device',
  host: 'Checking the assistant service',
  execution: 'Managing background work',
  terminal_process: 'Watching a process',
  support: 'Preparing a support bundle',
  vibe: 'Reading your VIBE profile',
  workspace: 'Driving the workspace',
  agent_harness: 'Checking app internals',
  route: 'Choosing the best route',
  delegation: 'Handing work off',
  audit: 'Reviewing evidence',
  context: 'Reading project context',
  agent_documents: 'Working on a document',
  agent_artifacts: 'Managing saved files',
  agent_media_generate: 'Generating media',
  agent_operator_method: 'Calling the assistant service',
  agent_operator_briefing: 'Preparing a briefing',
  agent_operator_action: 'Running an approved action',
  agent_work_plan: 'Organizing work',
  agent_review_packet_presets: 'Preparing a review packet',
  agent_review_packet_share: 'Sharing a review packet',
  propose_skill_drafts: 'Proposing skill drafts',
};

/**
 * Exported catalog of all registered tool IDs and their human phrases.
 * Tests import this to enumerate the full set of tool IDs for coverage checks.
 */
export const TOOL_LABELS_CATALOG: Readonly<Record<string, string>> = TOOL_LABELS;

function humanize(name: string): string {
  const short = name.includes('__') ? name.split('__').pop()! : name;
  return (short
    .replace(/^agent[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim())
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Return the human phrase for a tool call, falling back to a humanized
 * version of the raw name for unknown tools (including MCP tools).
 */
export function friendlyToolLabel(toolName: string): string {
  const short = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  return TOOL_LABELS[short] ?? TOOL_LABELS[toolName] ?? humanize(toolName);
}
