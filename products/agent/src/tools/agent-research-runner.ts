import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentResearchRunRegistry, type AgentResearchRunRecord } from '../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry, researchSourceReportLine, type AgentResearchSourceRecord } from '../agent/research-source-registry.ts';
import type { AgentResearchToolArgs } from './agent-research-tool.ts';

type ToolResult = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string };

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function searchArgs(args: AgentResearchToolArgs): Record<string, unknown> {
  const safeSearch = readString(args.safeSearch).toLowerCase() === 'strict' ? 'strict' : 'moderate';
  return compactArgs({
    query: args.query ?? args.target,
    providerId: args.providerId,
    maxResults: readNumber(args.maxResults, readNumber(args.limit, 5, 10), 10),
    verbosity: 'evidence',
    region: args.region,
    safeSearch,
    timeRange: args.timeRange,
    includeEvidence: true,
    evidenceTopN: readNumber(args.evidenceTopN, 3, 3),
    evidenceExtract: args.evidenceExtract ?? 'readable',
  });
}

function previewText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fallbackTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Deep research run';
  return cleaned.length <= 72 ? cleaned : `${cleaned.slice(0, 71).trimEnd()}...`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRecordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(readRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function sanitizeUrlForRoute(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|authorization|credential|api[-_]?key/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return url.toString();
  } catch {
    return value.replace(/([?&\s](?:token|secret|password|authorization|credential|api[-_]?key)=)[^\s&]+/gi, '$1<redacted>');
  }
}

function candidateFromSearchResult(question: string, result: Record<string, unknown>, index: number): Record<string, unknown> {
  const rawUrl = readString(result.url);
  const url = sanitizeUrlForRoute(rawUrl);
  const title = previewText(result.title, 120) || hostname(rawUrl) || `Search result ${index + 1}`;
  const publisher = previewText(result.domain, 80) || hostname(rawUrl);
  const evidenceRecords = readRecordArray(result.evidence);
  const evidenceText = previewText(
    evidenceRecords.map((entry) => readString(entry.content)).filter(Boolean).join('\n\n') || result.snippet,
    420,
  );
  const summary = previewText(result.snippet, 260) || previewText(evidenceText, 260) || `Public web result for ${question}.`;
  const captureArgs = compactArgs({
    action: 'add_source',
    question,
    title,
    url,
    publisher,
    summary,
    evidence: evidenceText,
    credibility: 'unreviewed',
    tags: ['research', 'web-search'],
    confirm: true,
    explicitUserRequest: '...',
  });
  return {
    rank: typeof result.rank === 'number' ? result.rank : index + 1,
    title,
    url,
    ...(publisher ? { publisher } : {}),
    summary,
    ...(evidenceText ? { evidencePreview: evidenceText } : {}),
    captureArgs,
    captureRoute: [
      'research action:"add_source"',
      `question:${quote(question)}`,
      `title:${quote(title)}`,
      ...(url ? [`url:${quote(url)}`] : []),
      ...(publisher ? [`publisher:${quote(publisher)}`] : []),
      `summary:${quote(summary)}`,
      ...(evidenceText ? [`evidence:${quote(evidenceText)}`] : []),
      'credibility:"unreviewed"',
      'tags:["research","web-search"]',
      'confirm:true',
      'explicitUserRequest:"..."',
    ].join(' '),
  };
}

function parseSearchPayload(outputValue: unknown): Record<string, unknown> | null {
  if (typeof outputValue !== 'string') return readRecord(outputValue);
  try {
    return readRecord(JSON.parse(outputValue));
  } catch {
    return null;
  }
}

function resolveSearchRun(args: AgentResearchToolArgs, shellPaths: CommandContext['workspace']['shellPaths'] | undefined): AgentResearchRunRecord | null {
  if (!shellPaths) return null;
  const lookup = readString(args.runId) || readString(args.id);
  if (!lookup) return null;
  return AgentResearchRunRegistry.fromShellPaths(shellPaths).get(lookup);
}

export async function runPublicSearch(
  webSearchTool: Tool | undefined,
  args: AgentResearchToolArgs,
  shellPaths: CommandContext['workspace']['shellPaths'] | undefined,
): Promise<ToolResult> {
  const run = resolveSearchRun(args, shellPaths);
  const query = readString(args.query) || readString(args.question) || run?.question || readString(args.target);
  if ((readString(args.runId) || readString(args.id)) && !run && !readString(args.query) && !readString(args.question)) {
    return error(`Unknown research run ${readString(args.runId) || readString(args.id)}. Use research action:"runs" to inspect run ids.`);
  }
  if (!query) return error('research action:"search" requires query or target.');
  if (!webSearchTool) {
    return error('Bounded public web search is unavailable because web_search is not registered. Use research action:"briefing" for the offline next-action queue or action:"plan" for the route plan.');
  }
  const webArgs = searchArgs({ ...args, query });
  const webResult = await webSearchTool.execute(webArgs);
  if (!webResult.success) return { success: false, error: readString(webResult.error) || 'web_search failed.' };
  const payload = parseSearchPayload(webResult.output);
  const results = readRecordArray(payload?.results);
  const sourceCandidates = results
    .filter((result) => readString(result.url))
    .map((result, index) => candidateFromSearchResult(query, result, index));
  return {
    success: true,
    output: JSON.stringify({
      status: sourceCandidates.length > 0 ? 'source-candidates-ready' : 'no-source-candidates',
      query,
      providerId: readString(payload?.providerId),
      providerLabel: readString(payload?.providerLabel),
      resultCount: results.length,
      sourceCandidateCount: sourceCandidates.length,
      sourceCandidates,
      nextRoutes: {
        ...(run ? {
          run: `research action:"run" runId:${quote(run.id)}`,
          briefing: `research action:"briefing" target:${quote(run.id)}`,
          startRun: `research action:"start_run" id:${quote(run.id)} confirm:true explicitUserRequest:"..."`,
          checkpointAfterCapture: `research action:"checkpoint" id:${quote(run.id)} phase:"reading" progress:${Math.max(run.progress, 25)} note:"Captured candidate sources for review." sourceIds:["..."] confirm:true explicitUserRequest:"..."`,
        } : {
          createRun: `research action:"create_run" question:${quote(query)} plan:["Search bounded public web sources","Capture candidate sources","Review credibility","Save sourced report"] confirm:true explicitUserRequest:"..."`,
        }),
        sourceQueue: `research action:"sources" query:${quote(query)}`,
        reviewedBundle: `research action:"bundle" query:${quote(query)} includeReportLines:true`,
        saveReport: `research action:"report" question:${quote(query)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`,
      },
      ...(run ? { run: { id: run.id, title: run.title, status: run.status, phase: run.phase, progress: run.progress } } : {}),
      searchArgs: webArgs,
      policy: 'This route performs bounded read-only public web search only. It does not create or start a run, save sources, checkpoint progress, write a report, ingest Knowledge, or send messages. Use each returned route only after explicit user confirmation.',
    }, null, 2),
  };
}

function requireConfirmedRunner(args: AgentResearchToolArgs): string {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error('research action:"runner" requires explicitUserRequest before it can create or checkpoint a visible research run.');
  if (args.confirm !== true) throw new Error('research action:"runner" requires confirm:true before it can create or checkpoint a visible research run.');
  return explicitUserRequest;
}

function researchSourceRoutes(source: AgentResearchSourceRecord): Record<string, unknown> {
  return {
    sourceId: source.id,
    title: source.title,
    status: source.status,
    credibility: source.credibility,
    score: source.score,
    inspectRoute: `research action:"source" sourceId:${quote(source.id)}`,
    reviewRoute: `research action:"review_source" id:${quote(source.id)} credibility:"high|medium|mixed|low" score:80 note:"..." confirm:true explicitUserRequest:"..."`,
    reportLine: researchSourceReportLine(source),
  };
}

function sourceFromCandidate(
  registry: AgentResearchSourceRegistry,
  question: string,
  candidate: Record<string, unknown>,
): { readonly source: AgentResearchSourceRecord; readonly created: boolean } | null {
  const title = readString(candidate.title);
  const summary = readString(candidate.summary);
  const url = readString(candidate.url);
  if (!title || !summary) return null;
  const publisher = readString(candidate.publisher);
  const evidence = readString(candidate.evidencePreview);
  try {
    return {
      created: true,
      source: registry.create({
        question,
        title,
        ...(url ? { url } : {}),
        ...(publisher ? { publisher } : {}),
        summary,
        ...(evidence ? { evidence } : {}),
        credibility: 'unreviewed',
        tags: ['research', 'web-search', 'runner'],
        note: 'Captured by confirmed GoodVibes research runner.',
        provenance: 'agent-research-runner',
      }),
    };
  } catch (err) {
    const existing = registry.get(url || title);
    if (existing) return { created: false, source: existing };
    throw err;
  }
}

export async function runConfirmedResearchRunner(
  webSearchTool: Tool | undefined,
  args: AgentResearchToolArgs,
  shellPaths: CommandContext['workspace']['shellPaths'] | undefined,
): Promise<ToolResult> {
  try {
    const explicitUserRequest = requireConfirmedRunner(args);
    if (!shellPaths) return error('Confirmed research runner is unavailable because this runtime did not provide shell paths.');
    if (!webSearchTool) return error('Confirmed research runner requires the web_search tool for bounded source collection. Use research action:"plan" for offline routing.');
    const runRegistry = AgentResearchRunRegistry.fromShellPaths(shellPaths);
    const sourceRegistry = AgentResearchSourceRegistry.fromShellPaths(shellPaths);
    const lookup = readString(args.runId) || readString(args.id);
    const existingRun = lookup ? runRegistry.get(lookup) : null;
    if (lookup && !existingRun) return error(`Unknown research run ${lookup}. Use research action:"runs" to inspect run ids.`);
    const question = readString(args.query) || readString(args.question) || readString(args.target) || existingRun?.question || explicitUserRequest;
    if (!question) return error('Confirmed research runner requires query, question, target, or an existing run with a question.');
    let run = existingRun ?? runRegistry.create({
      title: readString(args.title) || fallbackTitle(question),
      question,
      goal: readString(args.goal) || `Collect reviewed source candidates for: ${question}`,
      plan: [
        'Run bounded public web source collection.',
        'Save candidate sources into the local research source queue.',
        'Checkpoint the visible research run with source ids and next review steps.',
        'Save a citation-covered report only after source review.',
      ],
      nextSteps: ['Run bounded source collection.', 'Review candidate sources.', 'Save a sourced report artifact.'],
      note: `Confirmed runner authorized by user request: ${previewText(explicitUserRequest, 160)}`,
      provenance: 'agent-research-runner',
    });
    if (run.status === 'planned') {
      run = runRegistry.start(run.id, 'Confirmed research runner started bounded source collection.');
    } else if (run.status === 'paused' || run.status === 'blocked') {
      run = runRegistry.resume(run.id, 'Confirmed research runner resumed bounded source collection.');
    } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return error(`Cannot run confirmed research runner for ${run.status} research run ${run.id}. Create a follow-up run instead.`);
    }

    const webResult = await webSearchTool.execute(searchArgs({ ...args, query: run.question }));
    if (!webResult.success) {
      run = runRegistry.checkpoint(run.id, {
        status: 'blocked',
        phase: 'searching',
        progress: Math.max(run.progress, 10),
        note: `Confirmed research runner blocked during source collection: ${readString(webResult.error) || 'web_search failed.'}`,
        nextSteps: ['Inspect runner readiness.', 'Retry bounded source collection after search is available.'],
      });
      return {
        success: false,
        error: `Confirmed research runner blocked for ${run.id}: ${readString(webResult.error) || 'web_search failed.'}`,
      };
    }

    const payload = parseSearchPayload(webResult.output);
    const results = readRecordArray(payload?.results);
    const candidates = results
      .filter((result) => readString(result.url))
      .map((result, index) => candidateFromSearchResult(run.question, result, index));
    const saved = candidates
      .map((candidate) => sourceFromCandidate(sourceRegistry, run.question, candidate))
      .filter((entry): entry is { readonly source: AgentResearchSourceRecord; readonly created: boolean } => entry !== null);
    const sourceIds = saved.map((entry) => entry.source.id);
    const createdCount = saved.filter((entry) => entry.created).length;
    const duplicateCount = saved.length - createdCount;
    run = runRegistry.checkpoint(run.id, {
      status: 'running',
      phase: 'reading',
      progress: Math.max(run.progress, sourceIds.length > 0 ? 35 : 20),
      note: `Confirmed research runner captured ${createdCount} new source candidate(s)${duplicateCount > 0 ? ` and reused ${duplicateCount} existing source(s)` : ''}.`,
      nextSteps: sourceIds.length > 0
        ? ['Review candidate source credibility.', 'Save a citation-covered report artifact after source review.']
        : ['Try a more specific query or provider.', 'Capture sources manually if public search found none.'],
      sourceIds,
    });

    return {
      success: true,
      output: JSON.stringify({
        status: sourceIds.length > 0 ? 'source-collection-checkpointed' : 'no-source-candidates-checkpointed',
        run: {
          id: run.id,
          title: run.title,
          status: run.status,
          phase: run.phase,
          progress: run.progress,
          sourceIds: run.sourceIds,
          inspectRoute: `research action:"run" runId:${quote(run.id)}`,
          checkpointRoute: `research action:"checkpoint" id:${quote(run.id)} phase:"reading" progress:${Math.max(run.progress, 35)} note:"..." sourceIds:["..."] confirm:true explicitUserRequest:"..."`,
          cancelRoute: `research action:"cancel" id:${quote(run.id)} note:"..." confirm:true explicitUserRequest:"..."`,
        },
        query: run.question,
        providerId: readString(payload?.providerId),
        resultCount: results.length,
        sourceCandidateCount: candidates.length,
        savedSourceCount: createdCount,
        reusedSourceCount: duplicateCount,
        sources: saved.map((entry) => researchSourceRoutes(entry.source)),
        nextRoutes: {
          run: `research action:"run" runId:${quote(run.id)}`,
          sources: `research action:"sources" query:${quote(run.question)} includeReportLines:true`,
          reviewSource: 'research action:"review_source" id:"..." credibility:"high|medium|mixed|low" score:80 note:"..." confirm:true explicitUserRequest:"..."',
          bundle: `research action:"bundle" query:${quote(run.question)} includeReportLines:true`,
          saveReport: `research action:"report" question:${quote(run.question)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`,
        },
        policy: 'Confirmed research runner only creates/updates local visible research run state and local source queue records. It does not save a report, ingest Knowledge, send messages, or control a browser/PWA surface.',
      }, null, 2),
    };
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}
