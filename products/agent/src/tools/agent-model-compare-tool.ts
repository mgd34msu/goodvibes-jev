import { randomUUID } from 'node:crypto';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChatRequest, ChatResponse, LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolEffect, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerComparisonCandidate, runAdmittedComparisonCandidate } from './agent-model-compare-candidate.ts';
import { createComparisonOperation } from './agent-model-compare-operation.ts';
import { createZipArchive } from './artifact-archive.ts';
import type { AgentModelCompareToolArgs, AgentModelCompareToolDeps, SavedComparisonArtifact, StoredComparison } from './agent-model-compare-types.ts';
import { BLIND_LABELS, DEFAULT_CANDIDATE_COUNT, DEFAULT_MAX_TOKENS, DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES, MAX_SIDE_BY_SIDE_PREVIEW_BYTES, MIN_CANDIDATES, MODE_ANALYTICS, MODE_APPLY, MODE_EXPORT, MODE_HANDOFF, MODE_HANDOFF_ARCHIVE, MODE_HANDOFF_DIFF, MODE_JUDGE, MODE_REVEAL, MODE_REVIEW, MODE_ROUTE_DECISION, MODE_RUN, MODE_SIDE_BY_SIDE, MODE_SYNTHESIS } from './agent-model-compare-types.ts';
import { buildRunPromptFromArtifact, formatPreview, formatReveal, formatReview, formatRunResult, formatSavedComparisonArtifacts, formatSavedHandoffArtifacts, loadComparisonFromArtifact, parseMode, rememberComparison, resolveComparisonForRead, resolveCurrentModel, runCandidate, saveComparisonArtifact, selectComparisonModels } from './agent-model-compare-run.ts';
import { ensureSelectableWinnerModel, findCandidate, formatApplyPreview, formatApplyResult, formatComparisonAnalytics, formatComparisonSynthesis, formatJudgePreview, formatJudgmentResult, formatRouteDecisionPreview, formatRouteDecisionResult, loadJudgmentFromArtifact, loadSavedJudgments, parseRouteDecision, readComparisonAnalyticsFilters, saveComparisonJudgmentArtifact, saveRouteDecisionArtifact } from './agent-model-compare-judgment.ts';
import { comparisonExportMarkdown, comparisonHandoffMarkdown, formatSideBySideReview, judgmentExportMarkdown, loadHandoffRelatedArtifacts, saveComparisonExportArtifact, saveComparisonHandoffArtifact } from './agent-model-compare-export.ts';
import { buildComparisonHandoffArchivePayload, findRouteDecisionArtifactIdsForHandoff, formatExportPreview, formatExportResult, formatHandoffArchivePreview, formatHandoffArchiveResult, formatHandoffDiff, formatHandoffPreview, formatHandoffResult, loadHandoffArchiveArtifacts, loadHandoffDiffArtifact, loadHandoffFromArtifact, saveComparisonHandoffArchiveArtifact } from './agent-model-compare-handoff.ts';
import { clamp, failure, output, previewText, readBenchmarkKind, readBoolean, readComparisonTag, readModelRefs, readNumber, readOptionalBoolean, readString, readStringList } from './agent-model-compare-utils.ts';
export type { AgentModelCompareCatalogModel, AgentModelCompareModelCatalog, AgentModelCompareProviderRegistry, AgentModelCompareRouteUpdateResult, AgentModelCompareToolArgs, AgentModelCompareToolDeps } from './agent-model-compare-types.ts';

export function createAgentModelCompareTool(sourceDeps: AgentModelCompareToolDeps): Tool {
  const comparisons = new Map<string, StoredComparison>();
  if (sourceDeps.toolRegistry) registerComparisonCandidate(sourceDeps.toolRegistry, sourceDeps);
  return {
    definition: {
      name: 'agent_model_compare',
      description: 'Blind compare prompts/artifacts, review, route decisions, handoff, diff.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [MODE_RUN, MODE_REVEAL, MODE_REVIEW, MODE_SIDE_BY_SIDE, MODE_JUDGE, MODE_APPLY, MODE_ROUTE_DECISION, MODE_EXPORT, MODE_HANDOFF, MODE_HANDOFF_ARCHIVE, MODE_HANDOFF_DIFF, MODE_ANALYTICS, MODE_SYNTHESIS],
            description: 'Select compare workflow mode.',
          },
          prompt: {
            type: 'string',
            description: 'Exact prompt sent identically to every candidate model.',
          },
          modelRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional registry keys or model ids. Omit to auto-select candidates.',
          },
          candidateCount: {
            type: 'number',
            description: 'Number of candidates to auto-select when modelRefs is omitted. At least 2.',
          },
          rubric: {
            type: 'string',
            description: 'Optional judging rubric shown with the blinded results.',
          },
          systemPrompt: {
            type: 'string',
            description: 'Optional system prompt sent identically to every candidate model.',
          },
          maxTokens: {
            type: 'number',
            description: 'Optional per-candidate output cap. Defaults to 2048; the selected provider determines supported limits.',
          },
          reveal: {
            type: 'boolean',
            description: 'If true, include model identities immediately after the blinded outputs.',
          },
          saveArtifact: {
            type: 'boolean',
            description: 'Defaults true; save the local JSON review artifact.',
          },
          benchmarkKind: {
            type: 'string',
            description: 'Optional benchmark tag for saved comparisons or analytics filters.',
          },
          taskType: {
            type: 'string',
            description: 'Optional task type tag for saved comparisons or analytics filters.',
          },
          documentId: {
            type: 'string',
            description: 'Optional document id tag for saved comparisons or analytics filters.',
          },
          comparisonId: {
            type: 'string',
            description: 'Stored comparison id for mode reveal.',
          },
          artifactId: {
            type: 'string',
            description: 'Run source artifact, saved comparison, or judgment artifact id.',
          },
          leftArtifactId: {
            type: 'string',
            description: 'Left saved reviewer handoff artifact id for handoffDiff.',
          },
          rightArtifactId: {
            type: 'string',
            description: 'Right saved reviewer handoff artifact id for handoffDiff.',
          },
          sectionId: {
            type: 'string',
            description: 'Optional handoffDiff jump: all, metadata, policy, related, comparison.',
          },
          winnerBlindId: {
            type: 'string',
            description: 'Candidate label to save as winner, such as A or Candidate B.',
          },
          winner: {
            type: 'string',
            description: 'Alias for winnerBlindId.',
          },
          reasons: {
            type: 'string',
            description: 'User-visible reasons for the saved judgment.',
          },
          notes: {
            type: 'string',
            description: 'Optional extra judgment notes.',
          },
          decision: {
            type: 'string',
            enum: ['left-unchanged', 'leave-unchanged', 'keep-current', 'no-change', 'applied-winner'],
            description: 'Route-decision receipt choice for routeDecision mode.',
          },
          limit: {
            type: 'number',
            description: 'Max saved judgments to inspect.',
          },
          includeReasons: {
            type: 'boolean',
            description: 'If true, include short reason excerpts.',
          },
          relatedArtifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related artifacts for reviewer view or handoff.',
          },
          previewBytes: {
            type: 'number',
            description: 'Max bytes per related artifact preview.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional legacy audit field; does not authorize provider calls or writes.',
          },
          preview: { type: 'boolean', description: 'For mode:run, inspect a comparison request without metered provider calls or result writes.' },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request text retained with route-decision receipts.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, options) => {
      try {
        const operation = createComparisonOperation(sourceDeps, rawArgs, options);
        const deps = operation.deps;
        operation.assertCurrent();
        const args = rawArgs as AgentModelCompareToolArgs;
        const mode = parseMode(args.mode);
        if (args.preview === true && mode !== MODE_RUN) return failure('preview:true is available for mode:run.');
        if (mode === MODE_REVEAL || mode === MODE_REVIEW) {
          const comparisonId = readString(args.comparisonId);
          const artifactId = readString(args.artifactId);
          if (mode === MODE_REVIEW && !comparisonId && !artifactId) {
            return output(formatSavedComparisonArtifacts(deps.artifactStore));
          }
          if (!comparisonId && !artifactId) {
            return failure(`${mode} mode requires comparisonId or artifactId.`);
          }
          const comparison = await resolveComparisonForRead({
            artifactStore: deps.artifactStore,
            comparisons,
            comparisonId,
            artifactId,
          });
          if (!comparison) {
            return failure(`Unknown comparison. Run a new comparison or pass a saved comparison artifactId.`);
          }
          rememberComparison(comparisons, comparison);
          return output(mode === MODE_REVEAL ? formatReveal(comparison) : formatReview(comparison, readBoolean(args.reveal)));
        }

        if (mode === MODE_SIDE_BY_SIDE) {
          const artifactId = readString(args.artifactId);
          if (!artifactId) {
            return output([
              formatSavedComparisonArtifacts(deps.artifactStore),
              '',
              'Choose a saved comparison or judgment artifactId to render a side-by-side reviewer view.',
            ].join('\n'));
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Side-by-side reviewer view is unavailable because this runtime cannot read artifact content.');
          }
          const relatedArtifactIds = readStringList(args.relatedArtifactIds).filter((relatedId) => relatedId !== artifactId);
          const previewBytes = clamp(
            readNumber(args.previewBytes, DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES),
            200,
            MAX_SIDE_BY_SIDE_PREVIEW_BYTES,
          );
          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, previewBytes);
            rememberComparison(comparisons, comparison);
            return output(formatSideBySideReview({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              comparison,
              reveal: readBoolean(args.reveal),
              relatedArtifacts,
              previewBytes,
            }));
          }
          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, previewBytes);
          return output(formatSideBySideReview({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            judgment,
            reveal: judgment.revealIncludedInJudgment,
            relatedArtifacts,
            previewBytes,
          }));
        }

        if (mode === MODE_HANDOFF_DIFF) {
          const leftArtifactId = readString(args.leftArtifactId || args.artifactId);
          const rightArtifactId = readString(args.rightArtifactId);
          if (!leftArtifactId && !rightArtifactId) {
            return output([
              formatSavedHandoffArtifacts(deps.artifactStore),
              '',
              'Choose two saved reviewer handoff artifact ids with leftArtifactId and rightArtifactId to render a visual diff.',
            ].join('\n'));
          }
          if (!leftArtifactId || !rightArtifactId) {
            return failure('handoffDiff mode requires leftArtifactId and rightArtifactId.');
          }
          if (leftArtifactId === rightArtifactId) {
            return failure('handoffDiff mode requires two different reviewer handoff artifact ids.');
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Reviewer handoff diff is unavailable because this runtime cannot read artifact content.');
          }
          const left = await loadHandoffDiffArtifact(deps.artifactStore, leftArtifactId);
          const right = await loadHandoffDiffArtifact(deps.artifactStore, rightArtifactId);
          if (!left || !right) {
            return failure('Unknown reviewer handoff artifact. Pass two saved blind model comparison handoff artifact ids.');
          }
          return output(formatHandoffDiff({ left, right, sectionId: readString(args.sectionId) }));
        }

        if (mode === MODE_ANALYTICS) {
          const limit = clamp(readNumber(args.limit, 20), 1, 100);
          const filters = readComparisonAnalyticsFilters(args);
          const judgments = await loadSavedJudgments(deps.artifactStore, limit, filters);
          return output(formatComparisonAnalytics({
            judgments,
            limit,
            includeReasons: readOptionalBoolean(args.includeReasons, true),
            filters,
            storeAvailable: Boolean(deps.artifactStore?.list && deps.artifactStore.readContent),
          }));
        }

        if (mode === MODE_SYNTHESIS) {
          const limit = clamp(readNumber(args.limit, 20), 1, 100);
          const filters = readComparisonAnalyticsFilters(args);
          const judgments = await loadSavedJudgments(deps.artifactStore, limit, filters);
          return output(await formatComparisonSynthesis({
            artifactStore: deps.artifactStore, request: rawArgs, readingOptions: { signal: options?.signal, assertCurrent: operation.assertCurrent, sourceOwner: operation.sourceOwner },
            judgments,
            limit,
            includeReasons: readOptionalBoolean(args.includeReasons, true),
            filters,
            storeAvailable: Boolean(deps.artifactStore?.list && deps.artifactStore.readContent),
          }));
        }

        if (mode === MODE_JUDGE) {
          const comparisonId = readString(args.comparisonId);
          const artifactId = readString(args.artifactId);
          const winnerBlindId = readString(args.winnerBlindId ?? args.winner);
          const reasons = readString(args.reasons);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!comparisonId && !artifactId) return failure('judge mode requires comparisonId or artifactId.');
          if (!winnerBlindId) return failure('winnerBlindId is required for judge mode.');
          if (!reasons) return failure('reasons are required for judge mode.');
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatJudgePreview(args),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const comparison = await resolveComparisonForRead({
            artifactStore: deps.artifactStore,
            comparisons,
            comparisonId,
            artifactId,
          });
          if (!comparison) return failure('Unknown comparison. Run a new comparison or pass a saved comparison artifactId.');
          const winner = findCandidate(comparison, winnerBlindId);
          if (!winner) {
            return failure(`Unknown winnerBlindId ${winnerBlindId}. Available candidates: ${comparison.candidates.map((candidate) => candidate.blindId).join(', ')}.`);
          }
          const artifact = await saveComparisonJudgmentArtifact({
            artifactStore: deps.artifactStore,
            comparison,
            winner,
            reasons,
            notes: readString(args.notes),
            reveal: readBoolean(args.reveal),
          });
          rememberComparison(comparisons, comparison);
          return output(formatJudgmentResult({
            comparison,
            winner,
            artifact,
            reasons,
            reveal: readBoolean(args.reveal),
          }));
        }

        if (mode === MODE_APPLY) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return failure('apply mode requires a saved judgment artifactId.');
          if (!deps.applyModelRoute) {
            return failure('Model route updates are unavailable in this runtime. Use settings action:"set" for provider.model if available.');
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Saved judgment artifacts are unavailable because this runtime cannot read artifact content.');
          }
          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown judgment artifact. Pass a saved model comparison judgment artifactId.');
          if (!judgment.revealIncludedInJudgment || !judgment.winnerModel?.registryKey) {
            return failure('Judgment artifact does not include a revealed winner model. Save or reveal the judgment before applying a route update.');
          }
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatApplyPreview(judgment),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          await ensureSelectableWinnerModel(deps.modelCatalog, judgment.winnerModel.registryKey);
          const result = await deps.applyModelRoute(judgment.winnerModel.registryKey);
          await deps.modelCatalog.recordModelUsage?.(judgment.winnerModel.registryKey);
          let receipt: SavedComparisonArtifact | null = null;
          let receiptError: string | null = null;
          try {
            receipt = await saveRouteDecisionArtifact({
              artifactStore: deps.artifactStore,
              decision: 'applied-winner',
              judgment,
              route: result,
              explicitUserRequest,
            });
          } catch (error) {
            receiptError = error instanceof Error ? error.message : String(error);
          }
          return output(formatApplyResult({ judgment, result, receipt, receiptError }));
        }

        if (mode === MODE_ROUTE_DECISION) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          const decision = parseRouteDecision(args.decision);
          if (!artifactId) return failure('routeDecision mode requires a saved judgment artifactId.');
          if (decision !== 'left-unchanged') {
            return failure('routeDecision mode records leave-unchanged decisions. Use mode:"apply" to apply a revealed winner.');
          }
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Route-decision receipts are unavailable because this runtime cannot read and create artifact content.');
          }
          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown judgment artifact. Pass a saved model comparison judgment artifactId.');
          if (!judgment.revealIncludedInJudgment || !judgment.winnerModel?.registryKey) {
            return failure('Judgment artifact does not include a revealed winner model. Save or reveal the judgment before recording a route decision.');
          }
          const currentModel = (await resolveCurrentModel(deps.modelCatalog))?.registryKey ?? null;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatRouteDecisionPreview({ judgment, decision, currentModel }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const receipt = await saveRouteDecisionArtifact({
            artifactStore: deps.artifactStore,
            decision,
            judgment,
            currentModel,
            explicitUserRequest,
          });
          return output(formatRouteDecisionResult({ judgment, decision, receipt, currentModel }));
        }

        if (mode === MODE_EXPORT) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return failure('export mode requires a saved comparison or judgment artifactId.');
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Saved comparison export is unavailable because this runtime cannot read and create artifact content.');
          }

          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const reveal = readBoolean(args.reveal);
            if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
              return failure([
                formatExportPreview({
                  sourceKind: 'comparison',
                  sourceArtifactId: artifactId,
                  comparisonId: comparison.comparisonId,
                  reveal,
                }),
                '',
                'This operation requires current recorded effect admission.',
              ].join('\n'));
            }
            const artifact = await saveComparisonExportArtifact({
              artifactStore: deps.artifactStore,
              sourceArtifactId: artifactId,
              sourceKind: 'comparison',
              comparisonId: comparison.comparisonId,
              markdown: comparisonExportMarkdown(comparison, reveal),
              reveal,
            });
            rememberComparison(comparisons, comparison);
            return output(formatExportResult({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              artifact,
            }));
          }

          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          const reveal = judgment.revealIncludedInJudgment;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatExportPreview({
                sourceKind: 'judgment',
                sourceArtifactId: artifactId,
                comparisonId: judgment.comparisonId,
                reveal,
              }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const artifact = await saveComparisonExportArtifact({
            artifactStore: deps.artifactStore,
            sourceArtifactId: artifactId,
            sourceKind: 'judgment',
            comparisonId: judgment.comparisonId,
            markdown: judgmentExportMarkdown(judgment),
            reveal,
          });
          return output(formatExportResult({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            artifact,
          }));
        }

        if (mode === MODE_HANDOFF) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          const relatedArtifactIds = readStringList(args.relatedArtifactIds).filter((relatedId) => relatedId !== artifactId);
          if (!artifactId) return failure('handoff mode requires a saved comparison or judgment artifactId.');
          if (relatedArtifactIds.length === 0) return failure('handoff mode requires at least one relatedArtifactIds entry.');
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Reviewer handoff is unavailable because this runtime cannot read and create artifact content.');
          }

          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const reveal = readBoolean(args.reveal);
            if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
              return failure([
                formatHandoffPreview({
                  sourceKind: 'comparison',
                  sourceArtifactId: artifactId,
                  comparisonId: comparison.comparisonId,
                  reveal,
                  relatedArtifactIds,
                }),
                '',
                'This operation requires current recorded effect admission.',
              ].join('\n'));
            }
            const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds);
            const artifact = await saveComparisonHandoffArtifact({
              artifactStore: deps.artifactStore,
              sourceArtifactId: artifactId,
              sourceKind: 'comparison',
              comparisonId: comparison.comparisonId,
              relatedArtifactIds,
              markdown: comparisonHandoffMarkdown({
                sourceKind: 'comparison',
                sourceArtifactId: artifactId,
                comparisonId: comparison.comparisonId,
                comparisonMarkdown: comparisonExportMarkdown(comparison, reveal),
                reveal,
                relatedArtifacts,
              }),
              reveal,
            });
            rememberComparison(comparisons, comparison);
            return output(formatHandoffResult({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              relatedArtifactCount: relatedArtifacts.length,
              artifact,
            }));
          }

          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          const reveal = judgment.revealIncludedInJudgment;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatHandoffPreview({
                sourceKind: 'judgment',
                sourceArtifactId: artifactId,
                comparisonId: judgment.comparisonId,
                reveal,
                relatedArtifactIds,
              }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds);
          const artifact = await saveComparisonHandoffArtifact({
            artifactStore: deps.artifactStore,
            sourceArtifactId: artifactId,
            sourceKind: 'judgment',
            comparisonId: judgment.comparisonId,
            relatedArtifactIds,
            markdown: comparisonHandoffMarkdown({
              sourceKind: 'judgment',
              sourceArtifactId: artifactId,
              comparisonId: judgment.comparisonId,
              comparisonMarkdown: judgmentExportMarkdown(judgment),
              reveal,
              relatedArtifacts,
            }),
            reveal,
          });
          return output(formatHandoffResult({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            relatedArtifactCount: relatedArtifacts.length,
            artifact,
          }));
        }

        if (mode === MODE_HANDOFF_ARCHIVE) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return output(formatSavedHandoffArtifacts(deps.artifactStore));
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Reviewer handoff archive is unavailable because this runtime cannot read and create artifact content.');
          }

          const handoff = await loadHandoffFromArtifact(deps.artifactStore, artifactId);
          if (!handoff) return failure('Unknown reviewer handoff artifact. Pass a saved blind model comparison handoff artifactId.');
          const routeDecisionArtifactIds = findRouteDecisionArtifactIdsForHandoff(deps.artifactStore, handoff);
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatHandoffArchivePreview({ handoff, routeDecisionArtifactIds }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }

          const artifacts = await loadHandoffArchiveArtifacts(deps.artifactStore, handoff, routeDecisionArtifactIds);
          const payload = buildComparisonHandoffArchivePayload({ handoff, artifacts });
          const archive = createZipArchive(payload.entries);
          const artifact = await saveComparisonHandoffArchiveArtifact({
            artifactStore: deps.artifactStore,
            handoff,
            payload,
            archive,
          });
          return output(formatHandoffArchiveResult({
            handoff,
            artifact,
            artifactCount: payload.artifactCount,
            routeDecisionArtifactCount: payload.routeDecisionArtifactIds.length,
            sourceBytes: payload.sourceBytes,
            archiveBytes: archive.byteLength,
          }));
        }

        const promptInput = readString(args.prompt);
        const explicitUserRequest = readString(args.explicitUserRequest);
        const sourceArtifactId = readString(args.artifactId);
        const refs = readModelRefs(args.modelRefs);
        const benchmarkKind = readBenchmarkKind(args.benchmarkKind);
        const taskType = readComparisonTag(args.taskType);
        const requestedDocumentId = readComparisonTag(args.documentId);
        const candidateCount = Math.max(MIN_CANDIDATES, Math.trunc(readNumber(args.candidateCount, DEFAULT_CANDIDATE_COUNT)));
        if (!promptInput && !sourceArtifactId) return failure('prompt or artifactId is required.');
        if (args.preview === true) return output(formatPreview(args, refs, candidateCount));
        if (!assertCurrentToolEffect(rawArgs, options, 'send')) {
          return failure([
            formatPreview(args, refs, candidateCount),
            '',
            'This operation requires current recorded effect admission.',
          ].join('\n'));
        }
        const runPrompt = await buildRunPromptFromArtifact({
          artifactStore: deps.artifactStore,
          prompt: promptInput,
          artifactId: sourceArtifactId,
        });
        const prompt = runPrompt.prompt;

        const maxTokens = Math.max(1, Math.trunc(readNumber(args.maxTokens, DEFAULT_MAX_TOKENS)));
        const systemPrompt = readString(args.systemPrompt);
        const models = await selectComparisonModels(deps.modelCatalog, refs, candidateCount);
        operation.assertSend();
        const pending = models.map((model, index) => runAdmittedComparisonCandidate(sourceDeps.toolRegistry, options,
          model, BLIND_LABELS[index] ?? String(index + 1), prompt, systemPrompt, maxTokens, operation.assertCurrent, rawArgs, sourceArtifactId));
        const settled = await Promise.allSettled(pending);
        operation.assertCurrent();
        const results = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
        const reveal = readBoolean(args.reveal);
        const baseComparison: StoredComparison = {
          comparisonId: `cmp_${randomUUID()}`,
          createdAt: new Date().toISOString(),
          promptPreview: previewText(prompt, 160),
          rubric: readString(args.rubric),
          ...(runPrompt.sourceArtifact ? { sourceArtifact: runPrompt.sourceArtifact } : {}),
          ...(benchmarkKind ? { benchmarkKind } : {}),
          ...(taskType ? { taskType } : {}),
          ...(requestedDocumentId || runPrompt.sourceArtifact?.documentId ? { documentId: requestedDocumentId || runPrompt.sourceArtifact?.documentId } : {}),
          candidates: results,
        };
        const saved = await saveComparisonArtifact({
          artifactStore: deps.artifactStore,
          comparison: baseComparison,
          prompt,
          systemPrompt,
          maxTokens,
          revealIncludedInTranscript: reveal,
          enabled: readOptionalBoolean(args.saveArtifact, true),
          ...(benchmarkKind ? { benchmarkKind } : {}),
        });
        const comparison: StoredComparison = {
          ...baseComparison,
          ...(saved.artifact ? { artifact: saved.artifact } : {}),
          artifactStatus: saved.status,
        };
        operation.assertWrite();
        rememberComparison(comparisons, comparison);
        await Promise.allSettled(models.map((model) => deps.modelCatalog.recordModelUsage?.(model.registryKey)));
        operation.assertCurrent();
        const rendered = formatRunResult(comparison, reveal);
        return results.some((candidate) => candidate.status === 'completed')
          ? output(rendered)
          : failure(rendered);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentModelCompareTool(
  registry: ToolRegistry,
  deps: AgentModelCompareToolDeps,
): void {
  registry.register(createAgentModelCompareTool({ ...deps, toolRegistry: registry }));
}
