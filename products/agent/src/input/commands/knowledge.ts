import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { toBrowserKinds, toBrowserSourceKinds } from './knowledge-browser-flags.ts';
import { formatKnowledgeMap, renderKnowledgeAskResult } from './knowledge-format.ts';

const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;

type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];
type KnowledgeAskInput = Parameters<import('@goodvibes-jev/engine/sdk/platform/knowledge').KnowledgeService['ask']>[0];
type KnowledgeAskMode = NonNullable<KnowledgeAskInput['mode']>;

function isKnowledgeReviewAction(value: string | undefined): value is KnowledgeReviewAction {
  return KNOWLEDGE_REVIEW_ACTIONS.some(action => action === value);
}

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

function retainKnowledgeCommand(context: CommandContext, args: readonly string[], knowledge: NonNullable<NonNullable<CommandContext['clients']>['agentKnowledgeApi']>) {
  const session = context.session, runtime = session.runtime, sessionId = runtime.sessionId;
  const conversation = session.conversationManager, getSnapshot = conversation.getMessageSnapshot;
  const messages = typeof getSnapshot === 'function' ? JSON.stringify(getSnapshot.call(conversation)) : undefined;
  const clients = context.clients, extensions = context.extensions, output = context.print, invokedByModel = context.invokedByModel;
  const service = extensions.agentKnowledgeService;
  const originalArgs = [...args];
  const supplied = context.judgmentReadingOptions, signal = supplied?.signal;
  const callerCurrent = supplied?.assertCurrent, shouldStop = supplied?.shouldStop;
  const operations: (() => void)[] = [];
  const changed = () => new Error('Agent Knowledge command is no longer current.');
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const current: unknown = callerCurrent?.();
    if (current !== undefined) {
      try { void Promise.resolve(current).catch(() => {}); } catch { /* Refuse below. */ }
      throw changed();
    }
    if (shouldStop) {
      const stopped: unknown = shouldStop();
      if (stopped !== false) {
        try { void Promise.resolve(stopped).catch(() => {}); } catch { /* Refuse below. */ }
        throw changed();
      }
    }
    signal?.throwIfAborted();
    if (context.judgmentReadingOptions !== supplied || supplied?.signal !== signal
      || supplied?.assertCurrent !== callerCurrent || supplied?.shouldStop !== shouldStop
      || context.session !== session || session.runtime !== runtime || runtime.sessionId !== sessionId
      || session.conversationManager !== conversation || conversation.getMessageSnapshot !== getSnapshot
      || typeof getSnapshot === 'function' && JSON.stringify(getSnapshot.call(conversation)) !== messages
      || context.clients !== clients || clients?.agentKnowledgeApi !== knowledge || context.extensions !== extensions
      || extensions.agentKnowledgeService !== service
      || context.print !== output || context.invokedByModel !== invokedByModel
      || args.length !== originalArgs.length || args.some((arg, index) => arg !== originalArgs[index])) throw changed();
    for (const check of operations) check();
    signal?.throwIfAborted();
  };
  const options = { signal, assertCurrent, shouldStop };
  return {
    assertCurrent,
    print(text: string) { assertCurrent(); output.call(context, text); },
    retain<Owner extends object, Key extends keyof Owner>(owner: Owner, key: Key, getOwner: () => Owner | undefined) {
      const method = owner[key];
      operations.push(() => { if (getOwner() !== owner || owner[key] !== method) throw changed(); });
      assertCurrent();
      return { owner, method, options, assertCurrent };
    },
  };
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
    const command = retainKnowledgeCommand(context, args, knowledge);
    const print = command.print;

    try {
    command.assertCurrent();
    switch (sub) {
      case 'ask': {
        const service = context.extensions.agentKnowledgeService;
        if (!service?.ask) {
          print('[knowledge] Agent Knowledge ask is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.');
          return;
        }
        const ask = command.retain(service, 'ask', () => context.extensions.agentKnowledgeService);
        const valuedFlags = ['--limit', '--mode'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          print('[knowledge] Usage: /knowledge ask <query> [--limit <n>] [--mode <concise|standard|detailed>]');
          return;
        }
        const requestedMode = readFlag(rest, '--mode');
        const mode: KnowledgeAskMode = requestedMode === 'concise' || requestedMode === 'standard' || requestedMode === 'detailed'
          ? requestedMode
          : 'standard';
        const result = await ask.method.call(ask.owner, {
          query,
          limit: readPositiveIntFlag(rest, '--limit', 10),
          mode,
          includeSources: true,
          includeConfidence: true,
          includeLinkedObjects: true,
        });
        ask.assertCurrent();
        print(renderKnowledgeAskResult(result));
        break;
      }

      case 'status': {
        const read = command.retain(knowledge.status, 'get', () => knowledge.status);
        const status = await read.method.call(read.owner, {}, read.options);
        read.assertCurrent();
        print([
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
          print('[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest URL into Agent Knowledge ${url}`, '/knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'url', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, {
          url,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          sourceType: 'url',
          connectorId: 'url',
        });
        ingest.assertCurrent();
        print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? url}`);
        if (result.source.summary) print(`  ${result.source.summary}`);
        if (result.artifactId) print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'ingest-file': {
        const [path] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
        if (!path) {
          print('[knowledge] Usage: /knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest file into Agent Knowledge ${path}`, '/knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'artifact', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, {
          path,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-file',
        });
        ingest.assertCurrent();
        print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? path}`);
        if (result.source.summary) print(`  ${result.source.summary}`);
        if (result.artifactId) print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'ingest-artifact': {
        const [artifactId] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
        if (!artifactId) {
          print('[knowledge] Usage: /knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest artifact into Agent Knowledge ${artifactId}`, '/knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'artifact', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, {
          artifactId,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-artifact-browser',
        });
        ingest.assertCurrent();
        print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? artifactId}`);
        if (result.source.summary) print(`  ${result.source.summary}`);
        if (result.artifactId) print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'import-bookmarks': {
        const [path] = positionalArgs(rest);
        if (!path) {
          print('[knowledge] Usage: /knowledge import-bookmarks <path> --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `import bookmark file into Agent Knowledge ${path}`, '/knowledge import-bookmarks <path> --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'bookmarksFile', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, { path, sessionId: context.session.runtime.sessionId });
        ingest.assertCurrent();
        print(`[knowledge] Imported bookmarks ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
        }
        break;
      }

      case 'import-urls': {
        const [path] = positionalArgs(rest);
        if (!path) {
          print('[knowledge] Usage: /knowledge import-urls <path> --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `import URL list into Agent Knowledge ${path}`, '/knowledge import-urls <path> --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'urlsFile', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, { path, sessionId: context.session.runtime.sessionId });
        ingest.assertCurrent();
        print(`[knowledge] Imported URL list ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
        }
        break;
      }

      case 'import-browser-history':
      case 'sync-browser-history': {
        if (!confirmation.yes) {
          requireYesFlag(context, 'import browser history into Agent Knowledge', '/knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'browserHistory', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, {
          browsers: toBrowserKinds(readFirstStringListFlag(rest, ['--browsers', '--browser'])),
          sourceKinds: toBrowserSourceKinds(readFirstStringListFlag(rest, ['--sources', '--source-kinds', '--source-kind'])),
          homeOverride: readFlag(rest, '--home'),
          limit: readPositiveIntFlag(rest, '--limit', 250),
          sinceMs: readSinceMsFlag(rest),
          connectorId: 'goodvibes-agent-browser-history',
          sessionId: context.session.runtime.sessionId,
        });
        ingest.assertCurrent();
        print(`[knowledge] Imported browser knowledge: ${result.imported} ok, ${result.failed} failed`);
        if (result.profiles.length > 0) print(`  profiles ${result.profiles.length}`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
        }
        break;
      }

      case 'ingest-connector': {
        const [connectorId] = positionalArgs(rest, ['--input', '--path', '--content']);
        if (!connectorId) {
          print('[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        const input = parseConnectorInputFlag(rest);
        const path = readFlag(rest, '--path');
        const content = readFlag(rest, '--content');
        if (input === undefined && !path && !content) {
          print('[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `ingest connector input into Agent Knowledge for ${connectorId}`, '/knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes');
          return;
        }
        const ingest = command.retain(knowledge.ingest, 'connectorInput', () => knowledge.ingest);
        const result = await ingest.method.call(ingest.owner, {
          connectorId,
          input,
          path,
          content,
          sessionId: context.session.runtime.sessionId,
          allowPrivateHosts: rest.includes('--allow-private-hosts'),
        });
        ingest.assertCurrent();
        print(`[knowledge] Imported connector input: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
        }
        break;
      }

      case 'list': {
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const kind = (readFlag(rest, '--kind') ?? 'sources').toLowerCase();
        if (kind === 'nodes') {
          const read = command.retain(knowledge.graph.nodes, 'list', () => knowledge.graph.nodes);
          const nodes = await read.method.call(read.owner, limit, read.options);
          read.assertCurrent();
          if (nodes.length === 0) {
            print('[knowledge] No nodes.');
            return;
          }
          print(`[knowledge] ${nodes.length} node(s)`);
          for (const node of nodes) {
            print(`  ${node.id} [${node.kind}] ${node.title}`);
            if (node.summary) print(`    ${node.summary}`);
          }
          return;
        }
        if (kind === 'issues') {
          const read = command.retain(knowledge.graph.issues, 'list', () => knowledge.graph.issues);
          const issues = await read.method.call(read.owner, limit, read.options);
          read.assertCurrent();
          if (issues.length === 0) {
            print('[knowledge] No issues.');
            return;
          }
          print(`[knowledge] ${issues.length} issue(s)`);
          for (const issue of issues) {
            print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
            print(`    ${issue.message}`);
          }
          return;
        }
        const read = command.retain(knowledge.sources, 'list', () => knowledge.sources);
        const sources = await read.method.call(read.owner, limit, read.options);
        read.assertCurrent();
        if (sources.length === 0) {
          print('[knowledge] No sources.');
          return;
        }
        print(`[knowledge] ${sources.length} source(s)`);
        for (const source of sources) {
          print(`  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`);
          if (source.summary) print(`    ${source.summary}`);
        }
        break;
      }

      case 'search': {
        const valuedFlags = ['--limit'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          print('[knowledge] Usage: /knowledge search <query> [--limit <n>]');
          return;
        }
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const read = command.retain(knowledge.graph.items, 'search', () => knowledge.graph.items);
        const results = await read.method.call(read.owner, query, limit, read.options);
        read.assertCurrent();
        if (results.length === 0) {
          print('[knowledge] No results.');
          return;
        }
        print(`[knowledge] ${results.length} result(s)`);
        for (const result of results) {
          const title = result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id;
          print(`  ${result.id} [${result.kind}] score ${result.score} ${title}`);
          print(`    ${result.reason}`);
        }
        break;
      }

      case 'get': {
        const [id] = positionalArgs(rest);
        if (!id) {
          print('[knowledge] Usage: /knowledge get <id>');
          return;
        }
        const read = command.retain(knowledge.graph.items, 'get', () => knowledge.graph.items);
        const item = await read.method.call(read.owner, id, {}, read.options);
        read.assertCurrent();
        if (!item) {
          print(`[knowledge] Unknown item ${id}`);
          return;
        }
        if (item.source) {
          print(`[knowledge] source ${item.source.id}`);
          print(`  title ${item.source.title ?? 'untitled'}`);
          print(`  uri ${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`);
          print(`  status ${item.source.status}`);
          if (item.source.summary) print(`  summary ${item.source.summary}`);
        } else if (item.node) {
          print(`[knowledge] node ${item.node.id}`);
          print(`  type ${item.node.kind}`);
          print(`  title ${item.node.title}`);
          if (item.node.summary) print(`  summary ${item.node.summary}`);
        } else if (item.issue) {
          print(`[knowledge] issue ${item.issue.id}`);
          print(`  severity ${item.issue.severity}`);
          print(`  code ${item.issue.code}`);
          print(`  message ${item.issue.message}`);
        }
        if (item.relatedEdges.length > 0) {
          print('  relations');
          for (const edge of item.relatedEdges.slice(0, 12)) {
            print(`    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`);
          }
        }
        break;
      }

      case 'map': {
        const limit = readPositiveIntFlag(rest, '--limit', 50);
        const query = positionalArgs(rest, ['--limit']).join(' ').trim();
        const read = command.retain(knowledge.graph, 'map', () => knowledge.graph);
        const result = await read.method.call(read.owner, {
          limit,
          ...(query.length > 0 ? { query } : {}),
        }, read.options);
        read.assertCurrent();
        print(formatKnowledgeMap(result));
        break;
      }

      case 'lint': {
        const read = command.retain(knowledge.status, 'lint', () => knowledge.status);
        const issues = await read.method.call(read.owner);
        read.assertCurrent();
        if (issues.length === 0) {
          print('[knowledge] No lint issues.');
          return;
        }
        print(`[knowledge] ${issues.length} lint issue(s)`);
        for (const issue of issues) {
          print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          print(`    ${issue.message}`);
        }
        break;
      }

      case 'queue': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const read = command.retain(knowledge.graph.issues, 'list', () => knowledge.graph.issues);
        const issues = await read.method.call(read.owner, limit, read.options);
        read.assertCurrent();
        if (issues.length === 0) {
          print('Knowledge review queue is empty.');
          return;
        }
        print(`[knowledge] Review queue (${issues.length})`);
        for (const issue of issues) {
          print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          print(`    ${issue.message}`);
        }
        break;
      }

      case 'review-issue':
      case 'issue-review': {
        const [issueId, actionValue] = positionalArgs(rest, ['--reviewer', '--value']);
        const action = actionValue?.toLowerCase();
        if (!issueId || !isKnowledgeReviewAction(action)) {
          print('[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(context, `review Agent Knowledge issue ${issueId}`, '/knowledge review-issue <issueId> <action> [--reviewer <name>] [--value <json-object>] --yes');
          return;
        }
        const value = readJsonObjectFlag(rest, '--value');
        if (value === null) {
          print('[knowledge] --value must be a JSON object.');
          return;
        }
        try {
          const review = command.retain(knowledge.graph.issues, 'review', () => knowledge.graph.issues);
          const result = await review.method.call(review.owner, {
            issueId,
            action,
            reviewer: readFlag(rest, '--reviewer') ?? 'agent',
            ...(value ? { value } : {}),
          });
          review.assertCurrent();
          print([
            `[knowledge] Reviewed issue ${result.issue.id}`,
            `  action ${action}`,
            `  status ${result.issue.status}`,
            ...(result.node ? [`  node ${result.node.id} ${result.node.title}`] : []),
            ...(result.source ? [`  knowledge source ${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`] : []),
            ...(result.appliedFacts ? [`  applied facts ${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
          ].join('\n'));
        } catch (error) {
          print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case 'candidates': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const candidates = knowledge.consolidation.candidates(limit);
        if (candidates.length === 0) {
          print('[knowledge] No consolidation candidates.');
          return;
        }
        print(`[knowledge] Consolidation candidates (${candidates.length})`);
        for (const candidate of candidates) {
          print(`  ${candidate.id} [${candidate.status}] score ${candidate.score} ${candidate.title}`);
          print(`    ${candidate.candidateType}`);
        }
        break;
      }

      case 'connectors': {
        const [first, second] = positionalArgs(rest);
        if (first === 'doctor') {
          if (!second) {
            print('[knowledge] Usage: /knowledge connectors doctor <connectorId>');
            return;
          }
          const read = command.retain(knowledge.connectors, 'doctor', () => knowledge.connectors);
          const report = await read.method.call(read.owner, second);
          read.assertCurrent();
          if (!report) {
            print(`[knowledge] Connector doctor report unavailable ${second}`);
            return;
          }
          print([
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
            print(`[knowledge] Unknown connector ${first}`);
            return;
          }
          print([
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
          print('[knowledge] No connectors.');
          return;
        }
        print(`[knowledge] Connectors (${connectors.length})`);
        for (const connector of connectors) {
          print(`  ${connector.id} [${connector.sourceType}] ${connector.displayName ?? connector.id}`);
          print(`    ${connector.description}`);
        }
        break;
      }

      case 'reports': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const reports = knowledge.consolidation.reports(limit);
        if (reports.length === 0) {
          print('[knowledge] No consolidation reports.');
          return;
        }
        print(`[knowledge] Consolidation reports (${reports.length})`);
        for (const report of reports) {
          print(`  ${report.id} [${report.kind}] ${report.title}`);
          print(`    ${report.summary}`);
        }
        break;
      }

      case 'schedules': {
        const schedules = knowledge.jobs.schedules.list(20);
        if (schedules.length === 0) {
          print('[knowledge] No knowledge schedules.');
          return;
        }
        print(`[knowledge] Managed schedules (${schedules.length})`);
        for (const schedule of schedules) {
          print(`  ${schedule.id} [${schedule.enabled ? 'enabled' : 'disabled'}] ${schedule.jobId}`);
          print(`    ${schedule.label}`);
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
          print('[knowledge] Usage: /knowledge packet <task...> [--scope <path> ...]');
          return;
        }
        const read = command.retain(knowledge.packets, 'buildPrompt', () => knowledge.packets);
        const prompt = await read.method.call(read.owner, query, scopeValues, undefined, read.options);
        read.assertCurrent();
        print(prompt ?? '[knowledge] No structured knowledge matched that task.');
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
          print('[knowledge] Usage: /knowledge explain <task...> [--scope <path> ...]');
          return;
        }
        const read = command.retain(knowledge.packets, 'buildPrompt', () => knowledge.packets);
        const prompt = await read.method.call(read.owner, query, scopeValues, undefined, read.options);
        read.assertCurrent();
        print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'reindex': {
        if (!confirmation.yes) {
          requireYesFlag(context, 'reindex Agent Knowledge', '/knowledge reindex --yes');
          return;
        }
        const reindex = command.retain(knowledge.status, 'reindex', () => knowledge.status);
        const result = await reindex.method.call(reindex.owner);
        reindex.assertCurrent();
        print([
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
        const consolidate = command.retain(knowledge.jobs, 'run', () => knowledge.jobs);
        const run = await consolidate.method.call(consolidate.owner, jobId, { mode: 'inline' });
        consolidate.assertCurrent();
        print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
        break;
      }

      default:
        print([
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
      try { command.assertCurrent(); } catch { return; }
      print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
