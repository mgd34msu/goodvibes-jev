import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ToolDefinition } from '@goodvibes-jev/engine/sdk/platform/types';

const DEFAULT_TOOL_DESCRIPTION_LIMIT = 56;

const TOOL_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  agent: 'Inspect explicit subagent tasks.',
  audit: 'Inspect release readiness and evidence.',
  analyze: 'Analyze code impact, symbols, and project risk.',
  autonomy: 'Route ongoing work and inspect visible autonomy.',
  channel: 'Inspect or operate configured channel surfaces.',
  browser: 'Open, read, and act on real web pages.',
  channels: 'Inspect channel readiness, setup, triage, and receipts.',
  computer: 'Inspect/open browser, desktop, and computer routes.',
  context: 'Inspect project instructions and prompt context.',
  delegation: 'Inspect build delegation routes and policy.',
  context_accounting: 'Report live session context: usage and compaction.',
  control: 'Inspect commands, panels, and runtime posture.',
  device: 'Inspect/open device, voice, and browser routes.',
  execution: 'Inspect local work routes, history, and recovery.',
  edit: 'Edit files with exact, fuzzy, or regex replacements.',
  exec: 'Run shell commands with timeout and retry.',
  fetch: 'Fetch HTTP URLs with auth and sanitization.',
  find: 'Search files, content, symbols, and project structure.',
  goodvibes_context: 'Inspect current GoodVibes runtime and host harness.',
  goodvibes_settings: 'Inspect/update GoodVibes settings on explicit request.',
  host: 'Inspect GoodVibes host status, services, and methods.',
  import_goodvibes_settings: 'Preview/apply shared GoodVibes settings import.',
  inspect: 'Inspect project structure, APIs, routes, and deps.',
  mcp: 'Inspect MCP servers, tools, schemas, and trust state.',
  memory: 'Inspect memory posture, providers, curator, records.',
  models: 'Inspect model routes, providers, cookbook, and checks.',
  packet: 'Manage implementation and execution packets.',
  personal_ops: 'Brief, route, inspect, and read Personal Ops.',
  profile: 'Read/record what GoodVibes knows about the owner.',
  query: 'Track operator queries, answers, and closure.',
  read: 'Read files, outlines, symbols, and ranges.',
  research: 'Plan, track, source, and save research.',
  registry: 'Discover local skills, agents, tools, and templates.',
  remote: 'Manage remote runner pools and artifacts.',
  repl: 'Evaluate bounded JS, TS, Python, SQL, or GraphQL.',
  repo_map: 'Return a token-budgeted map of the repository.',
  route: 'Choose the best visible route for a user task.',
  schedule: 'List, create, edit, run, pause, resume schedules.',
  security: 'Read security posture, findings, and policy decisions.',
  sessions: 'Search and inspect saved sessions/bookmarks.',
  settings: 'List, inspect, change, reset, or import settings.',
  setup: 'Inspect and complete first-run Agent setup.',
  support: 'Inspect support bundle routes and redacted bundles.',
  state: 'Read/update session state and diagnostics.',
  task: 'Manage cross-session tasks and handoffs.',
  team: 'Manage team definitions, roles, and lanes.',
  terminal: 'Start visible tracked background shell commands.',
  vibe: 'Inspect/create/import VIBE.md personality.',
  workspace: 'Inspect/open workspace actions, UI, commands, keys.',
  web_search: 'Search the web through the configured provider.',
  workflow: 'Inspect/control configured workflow automation.',
  worklist: 'Manage durable worklists and checklist items.',
  write: 'Write files with batch, mkdir, backup, and validation.',
  process: 'List, poll, log, wait, stop tracked processes.',
  agent_harness: 'Harness catalog: modes, settings, commands, UI, tools.',
  agent_artifacts: 'Browse, preview, export, package, and archive artifacts.',
  agent_documents: 'Create drafts, comments, suggestions, artifact attach/insert, and exports.',
  agent_knowledge: 'Read isolated Agent Knowledge.',
  agent_knowledge_ingest: 'Ingest confirmed source into Agent Knowledge.',
  agent_learning_consolidation: 'Apply confirmed local duplicate learning phases.',
  agent_local_registry: 'Inspect/update Agent memory, notes, skills, routines.',
  agent_work_plan: 'Inspect/update the visible Agent-local work plan.',
  agent_operator_briefing: 'Read connected Agent operator state.',
  agent_operator_action: 'Run one confirmed allowlisted operator action.',
  agent_autonomy_schedule: 'Schedule one confirmed autonomous Agent task.',
  agent_schedule_edit: 'Edit one confirmed connected schedule.',
  agent_research_runs: 'Track visible local research run checkpoints.',
  agent_research_sources: 'Manage local research source review queue.',
  agent_research_report: 'Save one confirmed sourced research report artifact.',
  agent_reminder_schedule: 'Schedule one confirmed Agent reminder.',
  agent_channel_send: 'Send confirmed message to configured Agent target.',
  agent_notify: 'Send one confirmed plain-text notification.',
  agent_media_generate: 'Generate one confirmed image or video artifact.',
  agent_review_packet_presets: 'Save/list/refresh Document Ops packet presets.',
  agent_review_packet_share: 'Share confirmed review packet archive reference.',
  agent_model_compare: 'Blind compare prompts/artifacts, review, route receipts, handoff, diff.',
};

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  if (limit <= 3) return normalized.slice(0, limit);
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function stripSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'description') continue;
    result[key] = stripSchemaDescriptions(entry);
  }
  return result;
}

function compactToolDefinition(definition: ToolDefinition): void {
  definition.description = compactText(
    TOOL_DESCRIPTION_OVERRIDES[definition.name] ?? definition.description,
    DEFAULT_TOOL_DESCRIPTION_LIMIT,
  );
  definition.parameters = stripSchemaDescriptions(definition.parameters) as Record<string, unknown>;
}

export function compactRegisteredToolDefinitions(toolRegistry: ToolRegistry): void {
  for (const definition of toolRegistry.getToolDefinitions()) {
    compactToolDefinition(definition);
  }
}
