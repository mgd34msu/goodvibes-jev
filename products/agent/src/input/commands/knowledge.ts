import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { toBrowserKinds, toBrowserSourceKinds } from './knowledge-browser-flags.ts';
import { formatKnowledgeMap, nodeLabel, renderKnowledgeAskResult, sourceLabel } from './knowledge-format.ts';
import type { KnowledgeAskResult } from './knowledge-format.ts';

const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;

type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];
type KnowledgeAskInput = Parameters<import('@goodvibes-jev/engine/sdk/platform/knowledge').KnowledgeService['ask']>[0];
type KnowledgeAskMode = NonNullable<KnowledgeAskInput['mode']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireAgentKnowledgeApi(context: CommandContext) {
  const knowledgeApi = context.clients?.agentKnowledgeApi;
  if (!knowledgeApi) {
    context.print('[knowledge] Agent Knowledge API is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.');
    return null;
  }
  return knowledgeApi;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function findDisallowedKnowledgeScopeFlag(args: readonly string[]): string | null {
  const disallowed = [
    '--space',
    '--knowledge-space',
    '--knowledge-space-id',
    ['--knowledge', 'SpaceId'].join(''),
    '--include-all-spaces',
    ['--include', 'AllSpaces'].join(''),
    ['--home', 'graph'].join(''),
    ['--home', '-graph'].join(''),
  ];
  for (const token of args) {
    for (const flag of disallowed) {
      if (token === flag || token.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

function printScopeFlagRejection(context: CommandContext, flag: string): void {
  context.print([
    `[knowledge] Agent Knowledge is isolated; ${flag} is not accepted.`,
    '[knowledge] GoodVibes Agent must not use default knowledge or non-Agent product spaces.',
    '[knowledge] Use only /api/goodvibes-agent/knowledge/* Agent-owned routes.',
  ].join('\n'));
}

function readStringListFlag(args: string[], name: string): string[] {
  const value = readFlag(args, name);
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readPositiveIntFlag(args: string[], name: string, fallback: number): number {
  const raw = readFlag(args, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFirstStringListFlag(args: string[], names: readonly string[]): string[] {
  for (const name of names) {
    const values = readStringListFlag(args, name);
    if (values.length > 0) return values;
  }
  return [];
}

function readSinceMsFlag(args: string[]): number | undefined {
  const raw = readFlag(args, '--since-days');
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Date.now() - parsed * 24 * 60 * 60 * 1000;
}

function parseConnectorInputFlag(args: string[]): unknown {
  const value = readFlag(args, '--input');
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function readJsonObjectFlag(args: string[], name: string): Record<string, unknown> | null | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positionalArgs(args: string[], valuedFlags: readonly string[] = []): string[] {
  return args.filter((token, index) => {
    if (token.startsWith('--')) return false;
    if (index > 0 && valuedFlags.includes(args[index - 1]!)) return false;
    return true;
  });
}

function requireAgentKnowledgeAsk(context: CommandContext): ((input: KnowledgeAskInput) => Promise<KnowledgeAskResult>) | null {
  const serviceAsk = context.extensions.agentKnowledgeService?.ask?.bind(context.extensions.agentKnowledgeService);
  if (serviceAsk) return serviceAsk;

  context.print('[knowledge] Agent Knowledge ask is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.');
  return null;
}

export const knowledgeCommand: SlashCommand = {
  name: 'knowledge',
  aliases: ['know'],
  description: 'Agent Knowledge: isolated Agent-owned status, ask/search, source/node/issue lists, item lookup, map, connectors, ingest, and review queue.',
  hidden: true,
  usage: '<subcommand> [args]',
  argsHint: 'status|ask|search|list|get|map|connectors|ingest-url --yes|ingest-file --yes|ingest-artifact --yes|import-urls --yes|import-bookmarks --yes|import-browser-history --yes|ingest-connector --yes|review-issue --yes|reindex --yes',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    if (args.length === 0 && context.openAgentWorkspace) {
      context.openAgentWorkspace('knowledge');
      return;
    }
    const knowledge = requireAgentKnowledgeApi(context);
    if (!knowledge) {
      return;
    }
    const sub = (args[0] ?? 'status').toLowerCase();
    const confirmation = stripYesFlag(args.slice(1));
    const rest = [...confirmation.rest];
    const disallowedScopeFlag = findDisallowedKnowledgeScopeFlag(rest);
    if (disallowedScopeFlag) {
      printScopeFlagRejection(context, disallowedScopeFlag);
      return;
    }

    try {
    switch (sub) {
      case 'ask': {
        const ask = requireAgentKnowledgeAsk(context);
        if (!ask) return;
        const valuedFlags = ['--limit', '--mode'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge ask <query> [--limit <n>] [--mode <concise|standard|detailed>]');
          return;
        }
        const requestedMode = readFlag(rest, '--mode') as KnowledgeAskMode | undefined;
        const mode: KnowledgeAskMode = requestedMode && ['concise', 'standard', 'detailed'].includes(requestedMode)
          ? requestedMode
          : 'standard';
        const result = await ask({
          query,
          limit: readPositiveIntFlag(rest, '--limit', 10),
          mode,
          includeSources: true,
          includeConfidence: true,
          includeLinkedObjects: true,
        });
        context.print(renderKnowledgeAskResult(result));
        break;
      }

      case 'status': {
        const status = await knowledge.status.get();
        context.print([
          '[knowledge] Agent Knowledge status',
          `  ready: ${status.ready ? 'yes' : 'no'}`,
          `  storage: ${status.storagePath}`,
          `  sources: ${status.sourceCount}`,
          `  nodes: ${status.nodeCount}`,
          `  edges: ${status.edgeCount}`,
          `  issues: ${status.issueCount}`,
        ].join('\n'));
        break;
      }

      case 'ingest-url': {
        const [url] = positionalArgs(rest, ['--title', '--tags', '--folder']);
        if (!url) {
          context.print('[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest URL into Agent Knowledge ${url}`, '/knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const result = await knowledge.ingest.url({
          url,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          sourceType: 'url',
          connectorId: 'url',
        });
        context.print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? url}`);
        if (result.source.summary) context.print(`  ${result.source.summary}`);
        if (result.artifactId) context.print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'ingest-file': {
        const [path] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
        if (!path) {
          context.print('[knowledge] Usage: /knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest file into Agent Knowledge ${path}`, '/knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const result = await knowledge.ingest.artifact({
          path,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-file',
        });
        context.print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? path}`);
        if (result.source.summary) context.print(`  ${result.source.summary}`);
        if (result.artifactId) context.print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'ingest-artifact': {
        const [artifactId] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
        if (!artifactId) {
          context.print('[knowledge] Usage: /knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest artifact into Agent Knowledge ${artifactId}`, '/knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const result = await knowledge.ingest.artifact({
          artifactId,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-artifact-browser',
        });
        context.print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? artifactId}`);
        if (result.source.summary) context.print(`  ${result.source.summary}`);
        if (result.artifactId) context.print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'import-bookmarks': {
        const [path] = positionalArgs(rest);
        if (!path) {
          context.print('[knowledge] Usage: /knowledge import-bookmarks <path> --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `import bookmark file into Agent Knowledge ${path}`, '/knowledge import-bookmarks <path> --yes');
          return;
        }
        const result = await knowledge.ingest.bookmarksFile({ path, sessionId: context.session.runtime.sessionId });
        context.print(`[knowledge] Imported bookmarks ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error ${error}`);
        }
        break;
      }

      case 'import-urls': {
        const [path] = positionalArgs(rest);
        if (!path) {
          context.print('[knowledge] Usage: /knowledge import-urls <path> --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `import URL list into Agent Knowledge ${path}`, '/knowledge import-urls <path> --yes');
          return;
        }
        const result = await knowledge.ingest.urlsFile({ path, sessionId: context.session.runtime.sessionId });
        context.print(`[knowledge] Imported URL list ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error ${error}`);
        }
        break;
      }

      case 'import-browser-history':
      case 'sync-browser-history': {
        if (!confirmation.yes) {
          requireYesFlag(context, 'import browser history into Agent Knowledge', '/knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes');
          return;
        }
        const result = await knowledge.ingest.browserHistory({
          browsers: toBrowserKinds(readFirstStringListFlag(rest, ['--browsers', '--browser'])),
          sourceKinds: toBrowserSourceKinds(readFirstStringListFlag(rest, ['--sources', '--source-kinds', '--source-kind'])),
          homeOverride: readFlag(rest, '--home'),
          limit: readPositiveIntFlag(rest, '--limit', 250),
          sinceMs: readSinceMsFlag(rest),
          connectorId: 'goodvibes-agent-browser-history',
          sessionId: context.session.runtime.sessionId,
        });
        context.print(`[knowledge] Imported browser knowledge: ${result.imported} ok, ${result.failed} failed`);
        if (result.profiles.length > 0) context.print(`  profiles ${result.profiles.length}`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error ${error}`);
        }
        break;
      }

      case 'ingest-connector': {
        const [connectorId] = positionalArgs(rest, ['--input', '--path', '--content']);
        if (!connectorId) {
          context.print('[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        const input = parseConnectorInputFlag(rest);
        const path = readFlag(rest, '--path');
        const content = readFlag(rest, '--content');
        if (input === undefined && !path && !content) {
          context.print('[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest connector input into Agent Knowledge for ${connectorId}`, '/knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        const result = await knowledge.ingest.connectorInput({
          connectorId,
          input,
          path,
          content,
          sessionId: context.session.runtime.sessionId,
          allowPrivateHosts: rest.includes('--allow-private-hosts'),
        });
        context.print(`[knowledge] Imported connector input: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error ${error}`);
        }
        break;
      }

      case 'list': {
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const kind = (readFlag(rest, '--kind') ?? 'sources').toLowerCase();
        if (kind === 'nodes') {
          const nodes = knowledge.graph.nodes.list(limit);
          if (nodes.length === 0) {
            context.print('[knowledge] No nodes.');
            return;
          }
          context.print(`[knowledge] ${nodes.length} node(s)`);
          for (const node of nodes) {
            context.print(`  ${node.id} [${node.kind}] ${node.title}`);
            if (node.summary) context.print(`    ${node.summary}`);
          }
          return;
        }
        if (kind === 'issues') {
          const issues = knowledge.graph.issues.list(limit);
          if (issues.length === 0) {
            context.print('[knowledge] No issues.');
            return;
          }
          context.print(`[knowledge] ${issues.length} issue(s)`);
          for (const issue of issues) {
            context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
            context.print(`    ${issue.message}`);
          }
          return;
        }
        const sources = knowledge.sources.list(limit);
        if (sources.length === 0) {
          context.print('[knowledge] No sources.');
          return;
        }
        context.print(`[knowledge] ${sources.length} source(s)`);
        for (const source of sources) {
          context.print(`  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`);
          if (source.summary) context.print(`    ${source.summary}`);
        }
        break;
      }

      case 'search': {
        const valuedFlags = ['--limit'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge search <query> [--limit <n>]');
          return;
        }
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const results = knowledge.graph.items.search(query, limit);
        if (results.length === 0) {
          context.print('[knowledge] No results.');
          return;
        }
        context.print(`[knowledge] ${results.length} result(s)`);
        for (const result of results) {
          const title = result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id;
          context.print(`  ${result.id} [${result.kind}] score ${result.score} ${title}`);
          context.print(`    ${result.reason}`);
        }
        break;
      }

      case 'get': {
        const [id] = positionalArgs(rest);
        if (!id) {
          context.print('[knowledge] Usage: /knowledge get <id>');
          return;
        }
        const item = knowledge.graph.items.get(id);
        if (!item) {
          context.print(`[knowledge] Unknown item ${id}`);
          return;
        }
        if (item.source) {
          context.print(`[knowledge] source ${item.source.id}`);
          context.print(`  title ${item.source.title ?? 'untitled'}`);
          context.print(`  uri ${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`);
          context.print(`  status ${item.source.status}`);
          if (item.source.summary) context.print(`  summary ${item.source.summary}`);
        } else if (item.node) {
          context.print(`[knowledge] node ${item.node.id}`);
          context.print(`  type ${item.node.kind}`);
          context.print(`  title ${item.node.title}`);
          if (item.node.summary) context.print(`  summary ${item.node.summary}`);
        } else if (item.issue) {
          context.print(`[knowledge] issue ${item.issue.id}`);
          context.print(`  severity ${item.issue.severity}`);
          context.print(`  code ${item.issue.code}`);
          context.print(`  message ${item.issue.message}`);
        }
        if (item.relatedEdges.length > 0) {
          context.print('  relations');
          for (const edge of item.relatedEdges.slice(0, 12)) {
            context.print(`    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`);
          }
        }
        break;
      }

      case 'map': {
        const limit = readPositiveIntFlag(rest, '--limit', 50);
        const query = positionalArgs(rest, ['--limit']).join(' ').trim();
        const result = await knowledge.graph.map({
          limit,
          ...(query.length > 0 ? { query } : {}),
        });
        context.print(formatKnowledgeMap(result));
        break;
      }

      case 'lint': {
        const issues = await knowledge.status.lint();
        if (issues.length === 0) {
          context.print('[knowledge] No lint issues.');
          return;
        }
        context.print(`[knowledge] ${issues.length} lint issue(s)`);
        for (const issue of issues) {
          context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          context.print(`    ${issue.message}`);
        }
        break;
      }

      case 'queue': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const issues = knowledge.graph.issues.list(limit);
        if (issues.length === 0) {
          context.print('Knowledge review queue is empty.');
          return;
        }
        context.print(`[knowledge] Review queue (${issues.length})`);
        for (const issue of issues) {
          context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          context.print(`    ${issue.message}`);
        }
        break;
      }

      case 'review-issue':
      case 'issue-review': {
        const [issueId, actionValue] = positionalArgs(rest, ['--reviewer', '--value']);
        const action = actionValue?.toLowerCase();
        if (!issueId || !action || !KNOWLEDGE_REVIEW_ACTIONS.includes(action as KnowledgeReviewAction)) {
          context.print('[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `review Agent Knowledge issue ${issueId}`, '/knowledge review-issue <issueId> <action> [--reviewer <name>] [--value <json-object>] --yes');
          return;
        }
        const value = readJsonObjectFlag(rest, '--value');
        if (value === null) {
          context.print('[knowledge] --value must be a JSON object.');
          return;
        }
        try {
          const result = await knowledge.graph.issues.review({
            issueId,
            action: action as KnowledgeReviewAction,
            reviewer: readFlag(rest, '--reviewer') ?? 'agent',
            ...(value ? { value } : {}),
          });
          context.print([
            `[knowledge] Reviewed issue ${result.issue.id}`,
            `  action ${action}`,
            `  status ${result.issue.status}`,
            ...(result.node ? [`  node ${result.node.id} ${result.node.title}`] : []),
            ...(result.source ? [`  knowledge source ${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`] : []),
            ...(result.appliedFacts ? [`  applied facts ${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
          ].join('\n'));
        } catch (error) {
          context.print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case 'candidates': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const candidates = knowledge.consolidation.candidates(limit);
        if (candidates.length === 0) {
          context.print('[knowledge] No consolidation candidates.');
          return;
        }
        context.print(`[knowledge] Consolidation candidates (${candidates.length})`);
        for (const candidate of candidates) {
          context.print(`  ${candidate.id} [${candidate.status}] score ${candidate.score} ${candidate.title}`);
          context.print(`    ${candidate.candidateType}`);
        }
        break;
      }

      case 'connectors': {
        const [first, second] = positionalArgs(rest);
        if (first === 'doctor') {
          if (!second) {
            context.print('[knowledge] Usage: /knowledge connectors doctor <connectorId>');
            return;
          }
          const report = await knowledge.connectors.doctor(second);
          if (!report) {
            context.print(`[knowledge] Connector doctor report unavailable ${second}`);
            return;
          }
          context.print([
            `[knowledge] Connector doctor ${report.connectorId}`,
            `  ready: ${report.ready ? 'yes' : 'no'}`,
            `  summary: ${report.summary}`,
            ...(report.checks.length > 0 ? ['  checks:', ...report.checks.slice(0, 10).map((check) => `    - ${check.id} [${check.status}] ${check.label} - ${check.detail}`)] : []),
            ...(report.hints.length > 0 ? ['  hints:', ...report.hints.slice(0, 8).map((hint) => `    - ${hint}`)] : []),
          ].join('\n'));
          return;
        }
        if (first) {
          const connector = knowledge.connectors.get(first);
          if (!connector) {
            context.print(`[knowledge] Unknown connector ${first}`);
            return;
          }
          context.print([
            `[knowledge] Connector ${connector.id}`,
            `  name ${connector.displayName ?? connector.id}`,
            `  source type ${connector.sourceType}`,
            `  description ${connector.description}`,
            `  capabilities: ${connector.capabilities?.join(', ') || 'none'}`,
          ].join('\n'));
          return;
        }
        const connectors = knowledge.connectors.list();
        if (connectors.length === 0) {
          context.print('[knowledge] No connectors.');
          return;
        }
        context.print(`[knowledge] Connectors (${connectors.length})`);
        for (const connector of connectors) {
          context.print(`  ${connector.id} [${connector.sourceType}] ${connector.displayName ?? connector.id}`);
          context.print(`    ${connector.description}`);
        }
        break;
      }

      case 'reports': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const reports = knowledge.consolidation.reports(limit);
        if (reports.length === 0) {
          context.print('[knowledge] No consolidation reports.');
          return;
        }
        context.print(`[knowledge] Consolidation reports (${reports.length})`);
        for (const report of reports) {
          context.print(`  ${report.id} [${report.kind}] ${report.title}`);
          context.print(`    ${report.summary}`);
        }
        break;
      }

      case 'schedules': {
        const schedules = knowledge.jobs.schedules.list(20);
        if (schedules.length === 0) {
          context.print('[knowledge] No knowledge schedules.');
          return;
        }
        context.print(`[knowledge] Managed schedules (${schedules.length})`);
        for (const schedule of schedules) {
          context.print(`  ${schedule.id} [${schedule.enabled ? 'enabled' : 'disabled'}] ${schedule.jobId}`);
          context.print(`    ${schedule.label}`);
        }
        break;
      }

      case 'packet': {
        const scopeValues: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '--scope' && rest[index + 1]) {
            scopeValues.push(rest[index + 1]!);
            index += 1;
          }
        }
        const query = positionalArgs(rest, ['--scope']).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge packet <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        context.print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'explain': {
        const scopeValues: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '--scope' && rest[index + 1]) {
            scopeValues.push(rest[index + 1]!);
            index += 1;
          }
        }
        const query = positionalArgs(rest, ['--scope']).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge explain <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        context.print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'reindex': {
        if (!confirmation.yes) {
          requireYesFlag(context, 'reindex Agent Knowledge', '/knowledge reindex --yes');
          return;
        }
        const result = await knowledge.status.reindex();
        context.print([
          '[knowledge] Reindex complete',
          `  sources ${result.status.sourceCount}`,
          `  nodes ${result.status.nodeCount}`,
          `  edges ${result.status.edgeCount}`,
          `  issues ${result.status.issueCount}`,
        ].join('\n'));
        break;
      }

      case 'consolidate': {
        if (!confirmation.yes) {
          requireYesFlag(context, 'run Agent Knowledge consolidation', '/knowledge consolidate [light|deep] --yes');
          return;
        }
        const mode = (positionalArgs(rest)[0] ?? 'light').toLowerCase();
        const jobId = mode === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation';
        const run = await knowledge.jobs.run(jobId, { mode: 'inline' });
        context.print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
        break;
      }

      default:
        context.print([
          'Usage: /knowledge <subcommand>',
          '  status',
          '  ask <query> [--limit <n>] [--mode <concise|standard|detailed>]',
          '  ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
          '  ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
          '  ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
          '  ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
          '  import-bookmarks <path> --yes',
          '  import-urls <path> --yes',
          '  import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes',
          '  list [--kind <sources|nodes|issues>] [--limit <n>]',
          '  search <query> [--limit <n>]',
          '  get <id>',
          '  map [query] [--limit <n>]',
          '  queue [limit]',
          '  review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>] --yes',
          '  candidates [limit]',
          '  connectors [connectorId|doctor <connectorId>]',
          '  reports [limit]',
          '  schedules',
          '  lint',
          '  packet <task...> [--scope <path> ...]',
          '  explain <task...> [--scope <path> ...]',
          '  reindex --yes',
          '  consolidate [light|deep] --yes',
        ].join('\n'));
    }
    } catch (error) {
      context.print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
