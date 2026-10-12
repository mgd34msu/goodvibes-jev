import { withResearchCatalog, rankResearchRecords } from './agent-harness-research-catalog-source.ts';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import type { CommandContext } from '../input/command-registry.ts';
import {
  AgentResearchRunRegistry,
  researchRunLogTail,
  researchRunReportLine,
  type AgentResearchRunRecord,
} from '../agent/research-run-registry.ts';
import {
  AgentResearchSourceRegistry,
  researchSourceReportLine,
  type AgentResearchSourceRecord,
} from '../agent/research-source-registry.ts';
import { browserControlPosture, type BrowserControlPosture } from './agent-harness-browser-control.ts';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import {
  isCertifiedResearchLiveRecord,
  researchLiveReadModelSnapshot,
  type ResearchBrowserRunnerRecord,
  type ResearchVisualReportRecord,
} from './agent-harness-research-live-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessResearchWorkflowArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly runId?: unknown;
  readonly includeParameters?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fallbackTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Deep research run';
  return cleaned.length <= 72 ? cleaned : `${cleaned.slice(0, 71).trimEnd()}...`;
}





async function resolveRun(runs: readonly AgentResearchRunRecord[], input: string, options: CatalogRankingOptions): Promise<AgentResearchRunRecord | null> {
  const normalized = input.toLowerCase();
  if (!normalized) return runs.find(run => run.status === 'running' || run.status === 'blocked' || run.status === 'paused' || run.status === 'planned') ?? null;
  const exact = runs.find(run => run.id.toLowerCase() === normalized || run.title.toLowerCase() === normalized);
  if (exact) return exact;
  return selectHarnessCatalog(runs, input, run => ({ id: run.id, description: run.title, evidence: run }), options, 'agent.research.workflow.run');
}

async function relatedSources(sources: readonly AgentResearchSourceRecord[], run: AgentResearchRunRecord | null, question: string,
  options: CatalogRankingOptions): Promise<readonly AgentResearchSourceRecord[]> {
  const sourceIds = new Set(run?.sourceIds.map(id => id.toLowerCase()) ?? []);
  const linked = sources.filter(source => sourceIds.has(source.id.toLowerCase()) || (!!run && source.question.toLowerCase() === run.question.toLowerCase()));
  const ranked = question ? await rankResearchRecords(sources, question, source => ({ id: source.id, description: source.title, evidence: source }), options, 'agent.research.workflow.sources') : [];
  return [...new Set([...linked, ...ranked])];
}



async function matchingLiveRunners(records: readonly ResearchBrowserRunnerRecord[], run: AgentResearchRunRecord | null, question: string,
  options: CatalogRankingOptions): Promise<readonly ResearchBrowserRunnerRecord[]> {
  const linked = records.filter(record => (!!run && record.runId === run.id) || (!!run?.reportArtifactId && record.reportArtifactId === run.reportArtifactId));
  const ranked = question ? await rankResearchRecords(records, question, record => ({ id: record.id, description: record.question ?? record.status, evidence: record }), options, 'agent.research.workflow.live-runners') : [];
  return [...new Set([...linked, ...ranked])];
}

function matchingVisualReports(
  records: readonly ResearchVisualReportRecord[],
  run: AgentResearchRunRecord | null,
): readonly ResearchVisualReportRecord[] {
  if (!run?.reportArtifactId) return records;
  return records.filter((record) => record.reportArtifactId === run.reportArtifactId);
}

function runSummary(run: AgentResearchRunRecord, includeParameters: boolean): Record<string, unknown> {
  return {
    runId: run.id,
    title: run.title,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    sources: run.sourceIds.length,
    inspectRoute: `research action:"run" runId:${quote(run.id)}`,
    checkpointRoute: `research action:"checkpoint" id:${quote(run.id)} phase:"reading" progress:${Math.max(run.progress, 25)} note:"..." sourceIds:["..."] confirm:true explicitUserRequest:"..."`,
    cancelRoute: `research action:"cancel" id:${quote(run.id)} note:"..." confirm:true explicitUserRequest:"..."`,
    completeRoute: `research action:"complete" id:${quote(run.id)} reportArtifactId:"..." confirm:true explicitUserRequest:"..."`,
    runLine: researchRunReportLine(run),
    ...(includeParameters ? {
      question: run.question,
      goal: run.goal,
      plan: run.plan,
      nextSteps: run.nextSteps,
      sourceIds: run.sourceIds,
      logTail: researchRunLogTail(run, 5),
    } : {}),
  };
}

function sourceSummary(source: AgentResearchSourceRecord): Record<string, unknown> {
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

function browserRunnerContract(
  browser: BrowserControlPosture,
  liveRecords: readonly ResearchBrowserRunnerRecord[],
): Record<string, unknown> {
  const certified = liveRecords.filter(isCertifiedResearchLiveRecord);
  return {
    status: certified.length > 0 ? 'certified-live-runner' : browser.configured ? 'ready-with-confirmation' : 'setup-contract-needed',
    userOutcome: 'Run browser-backed research only when live browser state, authenticated pages, or interactive source discovery are necessary.',
    currentState: certified.length > 0
      ? 'The SDK/daemon published certified browser-backed research run records with visible controls, source/page receipts, bounded logs, and exact inspect routes.'
      : browser.configured
      ? 'A reviewed browser/desktop route is configured; use it only after the user accepts the browser-backed research scope.'
      : 'No reviewed browser-backed research runner is configured, so public web_search/fetch stays the current safe route.',
    requiredContracts: [
      'Certified schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata for every live browser-backed research run.',
      'Trusted browser or desktop-control route with setup posture status ready.',
      'Visible run id, phase/progress, current URL/task scope, checkpoint route, and pause/resume/cancel controls for every browser-backed research run.',
      'Source-capture receipt for each accepted source with URL/title/publisher/summary/provenance.',
      'Bounded log/output records suitable for the autonomy queue and research run log tail.',
      'Report draft/save handoff that preserves reviewed source ids and citation coverage requirements.',
      'No credential or page-content leakage outside bounded redacted source summaries.',
    ],
    setupRoutes: [
      ...certified.slice(0, 3).map((record) => record.modelRoute),
      'computer action:"control" includeParameters:true',
      'computer action:"setup" includeParameters:true',
      browser.setupRoute,
      ...browser.fallbackRoutes,
    ],
    recommendedRoute: certified[0]?.modelRoute ?? browser.recommendedRoute,
    fallbackRoutes: browser.fallbackRoutes,
    liveRecords: liveRecords.slice(0, 5),
    certifiedLiveRecords: certified.slice(0, 5),
    policy: 'Browser-backed research is not started by this workflow plan. Use certified live SDK/daemon records only as read-only evidence, and use returned confirmed routes before any browser/PWA, source-save, report-save, or Knowledge-ingest effect.',
  };
}

function visualReportContract(options: {
  readonly reviewedSources: number;
  readonly reportRoute: string;
  readonly bundleRoute: string;
  readonly question: string;
  readonly liveRecords: readonly ResearchVisualReportRecord[];
}): Record<string, unknown> {
  const certified = options.liveRecords.filter(isCertifiedResearchLiveRecord);
  return {
    status: certified.length > 0 ? 'certified-live-renderer' : options.reviewedSources > 0 ? 'visual-report-packet-ready' : 'waiting-for-reviewed-sources',
    userOutcome: 'Produce an inspectable research report with source-backed findings, citations, caveats, and handoff/export routes.',
    currentRoute: certified[0]?.modelRoute ?? (options.reviewedSources > 0 ? options.reportRoute : options.bundleRoute),
    currentState: certified.length > 0
      ? 'The SDK/daemon published a certified browser/PWA visual report render over the same reviewed report artifact, with source-map and citation-coverage evidence.'
      : options.reviewedSources > 0
      ? 'Agent can save a citation-covered markdown report artifact with a visual report packet now; browser/PWA rendering remains an optional view over the same artifact.'
      : 'Review at least one source before saving a report or visual packet.',
    requiredSections: [
      'at-a-glance summary',
      'evidence matrix',
      'findings board',
      'dated source or comparison view',
      'source map',
      'citation coverage',
      'confidence and caveats',
      'open questions',
      'next actions',
      'handoff checklist',
    ],
    acceptanceCriteria: [
      'Every material claim maps to a reviewed source line or an explicit caveat.',
      'The report artifact includes citation coverage metadata and repair hints.',
      'The visual report packet is generated by research action:"report" visualReport:true over the same saved report/source artifacts, not a separate uncited answer.',
      'Connected-host visual rendering counts only when the SDK/daemon publishes certified render route, source-map, citation coverage, section, publication, and receipt evidence.',
      'Knowledge ingest remains a separate confirmed action after report review.',
    ],
    routes: {
      reviewedSourceBundle: options.bundleRoute,
      saveVisualReport: options.reportRoute,
      saveMarkdownReport: options.reportRoute,
      ...(certified[0] ? { openRenderedReport: certified[0].renderRoute } : {}),
      reviewPacketWizard: 'agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"',
      archiveArtifacts: 'agent_artifacts mode:"archive" artifactIds:["..."] destinationPath:"exports/research-report.zip" confirm:true explicitUserRequest:"..."',
    },
    fallbackRoutes: [
      options.bundleRoute,
      options.reportRoute,
      'agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"',
      'agent_artifacts mode:"archive" artifactIds:["..."] destinationPath:"exports/research-report.zip" confirm:true explicitUserRequest:"..."',
    ],
    liveRecords: options.liveRecords.slice(0, 5),
    certifiedRendererRecords: certified.slice(0, 5),
    policy: `This contract is read-only planning for ${previewHarnessText(options.question, 96)}; saving reports, exports, packages, shares, or Knowledge ingest stay on separate confirmed routes.`,
  };
}

export async function researchWorkflowSummary(context: CommandContext, rawArgs: AgentHarnessResearchWorkflowArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return withResearchCatalog(context, rawArgs, options, () => null, async (rawArgs, _data, options) => {
    const caller = captureAsyncHarnessInput(rawArgs, options), args = caller.args;
    const browser = await browserControlPosture(context, context.extensions?.toolRegistry, caller.options);
    caller.assertCurrent();
    const includeParameters = args.includeParameters === true;
    const lookup = readString(args.runId) || readString(args.target) || readString(args.query);
    const shellPaths = context.workspace?.shellPaths;
    const runs = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths).list() : [];
    const sources = shellPaths ? AgentResearchSourceRegistry.fromShellPaths(shellPaths).list() : [];
    const run = await resolveRun(runs, lookup, caller.options);
    const question = run?.question || lookup || 'Research question goes here';
    const title = run?.title || fallbackTitle(question);
    const matchedSources = await relatedSources(sources, run, question, caller.options);
    const reviewedSources = matchedSources.filter((source) => source.status === 'reviewed' || source.status === 'used');
    const candidateSources = matchedSources.filter((source) => source.status === 'candidate');
    const liveResearch = await researchLiveReadModelSnapshot(context, caller.options);
    const liveRunnerRecords = await matchingLiveRunners(liveResearch.browserRunnerRecords, run, question, caller.options);
    const certifiedRunnerRecords = liveRunnerRecords.filter(isCertifiedResearchLiveRecord);
    const liveVisualRecords = matchingVisualReports(liveResearch.visualReportRecords, run);
    const certifiedVisualRecords = liveVisualRecords.filter(isCertifiedResearchLiveRecord);
    const status = !shellPaths
      ? 'unavailable'
      : run?.status === 'completed'
        ? 'report-saved'
        : reviewedSources.length > 0
          ? 'ready-to-report'
          : candidateSources.length > 0
            ? 'needs-source-review'
            : run
              ? 'needs-source-collection'
              : 'needs-visible-run';

    const createRoute = `research action:"create_run" title:${quote(title)} question:${quote(question)} plan:["Search bounded public web sources","Capture candidate sources","Review credibility and citation value","Save sourced report artifact"] nextSteps:["Run bounded web_search/fetch and capture source candidates"] confirm:true explicitUserRequest:"..."`;
    const sourceQuery = question;
    const reportTitle = run ? `${run.title} report` : `${title} report`;
    const reportRoute = `research action:"report" title:${quote(reportTitle)} question:${quote(question)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`;
    const bundleRoute = `research action:"bundle" query:${quote(sourceQuery)} includeReportLines:true`;

    return {
      status,
      question: previewHarnessText(question, includeParameters ? 220 : 120),
      ...(run ? { run: runSummary(run, includeParameters) } : {}),
      sourcePosture: {
        matched: matchedSources.length,
        candidates: candidateSources.length,
        reviewed: reviewedSources.length,
        used: matchedSources.filter((source) => source.status === 'used').length,
        queueRoute: `research action:"sources" query:${quote(sourceQuery)}`,
        bundleRoute,
        captureRoute: `research action:"add_source" question:${quote(question)} title:"..." url:"..." summary:"..." credibility:"unreviewed" tags:["research"] confirm:true explicitUserRequest:"..."`,
        reviewRoute: 'research action:"review_source" id:"..." credibility:"high|medium|mixed|low" score:80 note:"..." confirm:true explicitUserRequest:"..."',
        reportReadySources: reviewedSources.slice(0, includeParameters ? 8 : 3).map(sourceSummary),
        candidateSources: candidateSources.slice(0, includeParameters ? 8 : 3).map(sourceSummary),
      },
      browserBackedResearch: {
        status: certifiedRunnerRecords.length > 0 ? 'certified-live-runner' : browser.status,
        configured: browser.configured || certifiedRunnerRecords.length > 0,
        recommendedRoute: certifiedRunnerRecords[0]?.modelRoute ?? browser.recommendedRoute,
        fallbackRoutes: browser.fallbackRoutes,
        next: browser.configured
          ? 'Use reviewed browser/desktop tooling only when live browser state or authenticated pages are necessary.'
          : certifiedRunnerRecords.length > 0
            ? 'Inspect the certified live research runner record, then use confirmed routes for follow-up source, report, or browser effects.'
            : 'Use bounded public web_search/fetch routes now; inspect setup before browser-backed execution.',
        liveRunnerRecords: liveRunnerRecords.slice(0, includeParameters ? 8 : 3),
        certifiedLiveRunnerCount: certifiedRunnerRecords.length,
      },
      browserRunnerContract: browserRunnerContract(browser, liveRunnerRecords),
      visualReportContract: visualReportContract({
        reviewedSources: reviewedSources.length,
        reportRoute,
        bundleRoute,
        question,
        liveRecords: liveVisualRecords,
      }),
      workflow: [
        {
          id: 'visible-run',
          status: run ? 'ready' : 'needed',
          next: run ? 'Use the existing visible run record for checkpoints and cancellation.' : 'Create a visible run before multi-step research so the user can inspect or cancel it.',
          route: run ? `research action:"run" runId:${quote(run.id)}` : createRoute,
          confirmationBoundary: run ? 'Read-only inspection unless checkpoint/cancel/complete route is used.' : 'Creates local visible run state only; no web request, report, Knowledge ingest, or delivery.',
        },
        {
          id: 'collect-sources',
          status: certifiedRunnerRecords.length > 0 ? 'ready' : reviewedSources.length > 0 || candidateSources.length > 0 ? 'started' : 'needed',
          next: certifiedRunnerRecords.length > 0
            ? 'Use the certified live runner record to inspect source receipts, then review captured sources before report generation.'
            : browser.configured
            ? 'Collect bounded sources, preferring primary/current sources, then capture each useful source in the queue.'
            : 'Use web_search/fetch for public sources and capture each useful source in the queue.',
          route: certifiedRunnerRecords[0]?.modelRoute ?? 'web_search query:"..." verbosity:"evidence" maxResults:10 evidenceTopN:3 or fetch urls:[...]',
          captureRoute: `research action:"add_source" question:${quote(question)} title:"..." url:"..." summary:"..." credibility:"unreviewed" tags:["research"] confirm:true explicitUserRequest:"..."`,
        },
        {
          id: 'review-sources',
          status: candidateSources.length > 0 ? 'needed' : reviewedSources.length > 0 ? 'ready' : 'waiting',
          next: candidateSources.length > 0 ? 'Review candidate source credibility, score, and citation value.' : 'Wait until sources are captured, then review them before report generation.',
          route: `research action:"sources" query:${quote(sourceQuery)} includeParameters:true`,
          reviewRoute: 'research action:"review_source" id:"..." credibility:"high|medium|mixed|low" score:80 note:"..." confirm:true explicitUserRequest:"..."',
        },
        {
          id: 'save-report',
          status: certifiedVisualRecords.length > 0 || reviewedSources.length > 0 ? 'ready' : 'waiting',
          next: certifiedVisualRecords.length > 0 ? 'Inspect the certified browser/PWA report render, then export, archive, or promote only after review.' : reviewedSources.length > 0 ? 'Use the reviewed-source bundle and save a citation-covered visual report packet artifact.' : 'Save the report only after reviewed or used sources exist.',
          route: certifiedVisualRecords[0]?.modelRoute ?? (reviewedSources.length > 0 ? bundleRoute : `research action:"sources" query:${quote(sourceQuery)}`),
          reportRoute,
        },
        {
          id: 'promote-knowledge',
          status: run?.reportArtifactId ? 'ready' : 'waiting',
          next: run?.reportArtifactId ? 'Promote the reviewed report artifact only if the user wants it durable in Agent Knowledge.' : 'Wait for a saved report artifact before Knowledge promotion.',
          route: run?.reportArtifactId
            ? `agent_knowledge_ingest sourceKind:"artifact" artifactId:${quote(run.reportArtifactId)} confirm:true explicitUserRequest:"..."`
            : 'agent_knowledge_ingest sourceKind:"artifact" artifactId:"..." confirm:true explicitUserRequest:"..."',
        },
      ],
      routes: {
        createRun: createRoute,
        inspectRuns: 'research action:"runs"',
        inspectSources: `research action:"sources" query:${quote(sourceQuery)}`,
        bundleSources: bundleRoute,
        saveReport: reportRoute,
        ...(certifiedRunnerRecords[0] ? { liveRunner: certifiedRunnerRecords[0].modelRoute } : {}),
        ...(certifiedVisualRecords[0] ? { liveVisualReport: certifiedVisualRecords[0].modelRoute } : {}),
        ...(run ? {
          checkpointRun: `research action:"checkpoint" id:${quote(run.id)} phase:"reading" progress:${Math.max(run.progress, 25)} note:"..." sourceIds:["..."] confirm:true explicitUserRequest:"..."`,
          completeRun: `research action:"complete" id:${quote(run.id)} reportArtifactId:"..." confirm:true explicitUserRequest:"..."`,
        } : {}),
      },
      policy: 'This is a read-only workflow plan. It does not search the web, mutate run/source state, save a report, ingest Knowledge, or send external messages. Use the returned confirmed routes for each separate effect.',
    };

  });
}
