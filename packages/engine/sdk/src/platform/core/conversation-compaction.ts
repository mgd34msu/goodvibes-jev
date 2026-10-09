import type { ProviderMessage } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { captureCompactionJudgment } from './compaction-judgment-binding.js';
import { compactMessages } from './context-compaction.js';
import type { CompactionContext } from './context-compaction.js';
import type { CompactionReceipt, CompactionResult, CompactionStrategyChoice } from './compaction-types.js';
import { CompactionQualityError } from './compaction-types.js';
import { distillConversation, DistillerUnavailableError } from './distiller-compaction.js';
import { computeQualityScore, LOW_QUALITY_THRESHOLD } from '../runtime/compaction/quality-score.js';
import type { CompactionQualityScore } from '../runtime/compaction/quality-score.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { SessionLineageTracker } from './session-lineage.js';
import { summarizeError } from '../utils/error-display.js';

/** Score a compaction result through the shared compaction quality scorer. */
function scoreResult(
  llmMessages: ProviderMessage[],
  result: CompactionResult,
  contextWindow: number,
  signal?: AbortSignal,
  beforeAttempt?: () => void,
): Promise<CompactionQualityScore> {
  return computeQualityScore(
    {
      sessionId: '',
      messages: llmMessages,
      tokensBefore: result.tokensBeforeEstimate,
      contextWindow,
      strategy: 'autocompact',
    },
    {
      messages: result.messages,
      tokensAfter: result.tokensAfterEstimate,
      summary: result.summary,
      strategy: 'autocompact',
      durationMs: 0,
      warnings: result.validationWarnings,
    },
    { ...(signal ? { signal } : {}), ...(beforeAttempt ? { beforeAttempt } : {}) },
  );
}

/**
 * Run the requested compaction strategy, falling back from `distiller` to the
 * structured strategy when the distillation is unavailable or scores below the
 * quality floor. The SAME quality scorer gates both, a low-quality
 * distillation never replaces the conversation on its own; it defers to
 * structured, and the fallback is named on the returned info.
 */
async function produceCompaction(
  llmMessages: ProviderMessage[],
  compactionContext: CompactionContext,
  registry: ProviderRegistry,
  assertJudgmentCurrent: () => void,
): Promise<{
  result: CompactionResult;
  strategy: CompactionStrategyChoice;
  requestedStrategy: CompactionStrategyChoice;
  fallbackReason?: string;
}> {
  compactionContext.signal?.throwIfAborted();
  const requested: CompactionStrategyChoice = compactionContext.strategy ?? 'structured';

  if (requested === 'distiller') {
    try {
      const distilled = await distillConversation(compactionContext, registry);
      assertJudgmentCurrent();
      const quality = await scoreResult(llmMessages, distilled, compactionContext.contextWindow, compactionContext.signal, assertJudgmentCurrent);
      assertJudgmentCurrent();
      const noReduction = distilled.tokensAfterEstimate >= distilled.tokensBeforeEstimate;
      if (!quality.isLowQuality && !noReduction) {
        return { result: distilled, strategy: 'distiller', requestedStrategy: 'distiller' };
      }
      const reason = quality.isLowQuality
        ? `distillation quality ${quality.score.toFixed(2)} (${quality.grade}) below floor ${LOW_QUALITY_THRESHOLD}; fell back to structured`
        : `distillation produced no token reduction; fell back to structured`;
      logger.warn('Distiller fell back to structured compaction', { reason });
      assertJudgmentCurrent();
      const structured = await compactMessages(compactionContext, registry);
      return { result: structured, strategy: 'structured', requestedStrategy: 'distiller', fallbackReason: reason };
    } catch (err) {
      if (!(err instanceof DistillerUnavailableError)) throw err;
      const reason = `distiller unavailable (${err.message}); fell back to structured`;
      logger.warn('Distiller unavailable; falling back to structured compaction', { reason });
      assertJudgmentCurrent();
      const structured = await compactMessages(compactionContext, registry);
      return { result: structured, strategy: 'structured', requestedStrategy: 'distiller', fallbackReason: reason };
    }
  }

  const structured = await compactMessages(compactionContext, registry);
  return { result: structured, strategy: 'structured', requestedStrategy: 'structured' };
}

/**
 * Resolve the effective compaction strategy from the `behavior.compactionStrategy`
 * config value and the `compaction-distiller-strategy` feature-flag state.
 *
 * The distiller only runs when BOTH the config selects it AND the flag is on,
 * the flag is the graduation gate, so a `distiller` config value with a dark
 * flag honestly resolves back to `structured` (the un-graduated default). Any
 * unrecognized config value also resolves to `structured`.
 */
export function resolveCompactionStrategy(
  configStrategy: string | undefined,
  distillerFlagEnabled: boolean,
): CompactionStrategyChoice {
  if (configStrategy === 'distiller' && distillerFlagEnabled) return 'distiller';
  return 'structured';
}

export interface ConversationCompactionHost {
  getMessageCount(): number;
  getMessagesForLLM(): ProviderMessage[];
  replaceMessagesForLLM(newMessages: ProviderMessage[]): void;
  getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null;
  getSessionLineageTracker(): Pick<SessionLineageTracker, 'addCompactionEntry'>;
}

export async function compactConversation(
  host: ConversationCompactionHost,
  registry: ProviderRegistry,
  modelId: string,
  trigger: 'auto' | 'manual' = 'manual',
  provider?: string,
  context?: CompactionContext,
): Promise<CompactionReceipt | undefined> {
  if (host.getMessageCount() === 0) return undefined;

  try {
    const assertJudgmentCurrent = captureCompactionJudgment();
    const llmMessages = host.getMessagesForLLM();
    const sourceSnapshot = JSON.stringify(llmMessages);
    if (context && JSON.stringify(context.messages) !== sourceSnapshot) {
      throw new Error('Compaction context is stale; current conversation retained.');
    }
    const compactionContext: CompactionContext = context ?? {
      messages: llmMessages,
      trigger,
      extractionModelId: modelId,
      extractionProvider: provider,
      sessionMemories: [],
      agents: [],
      contracts: [],
      activePlan: null,
      lineageEntries: [],
      compactionCount: 0,
      contextWindow: 0,
    };
    // Select and run the compaction strategy. The distiller (fresh-context)
    // strategy falls back to structured, through the SAME quality scorer,
    // when its distillation is unavailable or scores below the floor; the
    // fallback is named on the receipt.
    const produced = await produceCompaction(llmMessages, compactionContext, registry, assertJudgmentCurrent);
    assertJudgmentCurrent();
    const { result } = produced;

    // Quality guard: score the compaction before committing it. A low-quality
    // result (e.g. no compression, or a destroyed handoff) is rejected, the
    // full conversation is kept and the failure is surfaced honestly rather
    // than silently swapping in a bad summary.
    const quality = await scoreResult(llmMessages, result, compactionContext.contextWindow, compactionContext.signal, assertJudgmentCurrent);

    const strategyFellBack = produced.strategy !== produced.requestedStrategy;
    const receiptBase = {
      trigger,
      strategy: produced.strategy,
      tokensBefore: result.tokensBeforeEstimate,
      tokensAfter: result.tokensAfterEstimate,
      messagesBefore: result.event.messagesBeforeCompaction,
      messagesAfter: result.event.messagesAfterCompaction,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
      lowQuality: quality.isLowQuality,
      instructionsReinjected: result.event.instructionsReinjected ?? false,
      validationPassed: result.validationWarnings.length === 0,
      sectionsIncluded: result.sections.map((s) => s.id),
      ...(strategyFellBack ? { requestedStrategy: produced.requestedStrategy } : {}),
      ...(produced.fallbackReason ? { strategyFallbackReason: produced.fallbackReason } : {}),
    };

    // Fail honestly when the scorer flags low quality OR the compaction bought
    // nothing (output no smaller than input). The latter is a real failed
    // compaction the composite score can miss, it rewards the compression axis
    // even when a broken/empty extraction technically "shrank" tokens, so a
    // no-net-reduction result is treated as a failure and the conversation is
    // kept rather than swapping in a summary that did not help.
    const noReduction = result.tokensAfterEstimate >= result.tokensBeforeEstimate;
    if (quality.isLowQuality || noReduction) {
      const detail = quality.isLowQuality
        ? `Compaction quality ${quality.score.toFixed(2)} (${quality.grade}) below threshold ${LOW_QUALITY_THRESHOLD}; conversation retained. ${quality.description}`
        : `Compaction produced no token reduction (${result.tokensBeforeEstimate} -> ${result.tokensAfterEstimate}); conversation retained.`;
      logger.warn('Compaction rejected by quality guard, conversation kept', { detail, trigger });
      throw new CompactionQualityError({ ...receiptBase, lowQuality: true, outcome: 'kept-original', detail });
    }

    compactionContext.signal?.throwIfAborted();
    assertJudgmentCurrent();
    // Generic hosts may return fresh arrays, so compare their exact message
    // data. ConversationManager also fences its existing revision at commit,
    // detecting branch changes and change-then-restore while readings wait.
    if (JSON.stringify(host.getMessagesForLLM()) !== sourceSnapshot) {
      throw new Error('Conversation changed during compaction; current conversation retained.');
    }
    host.replaceMessagesForLLM(result.messages);

    const memoriesCount = host.getSessionMemoryStore()?.list().length ?? 0;
    const memoriesPart = memoriesCount > 0 ? `, ${memoriesCount} pinned memories` : '';
    const saved = result.tokensBeforeEstimate - result.tokensAfterEstimate;
    const savedKTokens = Math.round(saved / 1000);
    host.getSessionLineageTracker().addCompactionEntry(
      `${trigger} compact, saved ~${savedKTokens}K tokens${memoriesPart}.`,
    );

    logger.info('Conversation compacted', {
      trigger,
      messagesBeforeCompaction: result.event.messagesBeforeCompaction,
      messagesAfterCompaction: result.event.messagesAfterCompaction,
      tokensBeforeEstimate: result.tokensBeforeEstimate,
      tokensAfterEstimate: result.tokensAfterEstimate,
      tokensSaved: saved,
      qualityScore: quality.score,
      qualityGrade: quality.grade,
    });

    return { ...receiptBase, outcome: 'applied' };
  } catch (err: unknown) {
    if (err instanceof CompactionQualityError) throw err;
    const msg = summarizeError(err);
    logger.error('Compact failed', { error: msg });
    throw err;
  }
}
