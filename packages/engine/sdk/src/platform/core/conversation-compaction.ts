import { OwnedJudgmentWork } from '../runtime/owned-judgment-work.js';
import type { ProviderMessage } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
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
  work: OwnedJudgmentWork,
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
    work.options('runtime.compaction.quality-score'),
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
  work: OwnedJudgmentWork,
): Promise<{
  result: CompactionResult;
  strategy: CompactionStrategyChoice;
  requestedStrategy: CompactionStrategyChoice;
  fallbackReason?: string;
}> {
  const requested: CompactionStrategyChoice = compactionContext.strategy ?? 'structured';

  if (requested === 'distiller') {
    try {
      const distilled = await distillConversation(compactionContext, registry);
      work.assertCurrent();
      const quality = await scoreResult(llmMessages, distilled, compactionContext.contextWindow, work);
      work.assertCurrent();
      const noReduction = distilled.tokensAfterEstimate >= distilled.tokensBeforeEstimate;
      if (!quality.isLowQuality && !noReduction) {
        return { result: distilled, strategy: 'distiller', requestedStrategy: 'distiller' };
      }
      const reason = quality.isLowQuality
        ? `distillation quality ${quality.score.toFixed(2)} (${quality.grade}) below floor ${LOW_QUALITY_THRESHOLD}; fell back to structured`
        : `distillation produced no token reduction; fell back to structured`;
      logger.warn('Distiller fell back to structured compaction', { reason });
      const structured = await compactMessages(compactionContext, registry);
      work.assertCurrent();
      return { result: structured, strategy: 'structured', requestedStrategy: 'distiller', fallbackReason: reason };
    } catch (err) {
      work.assertCurrent();
      if (!(err instanceof DistillerUnavailableError)) throw err;
      const reason = `distiller unavailable (${err.message}); fell back to structured`;
      logger.warn('Distiller unavailable; falling back to structured compaction', { reason });
      const structured = await compactMessages(compactionContext, registry);
      work.assertCurrent();
      return { result: structured, strategy: 'structured', requestedStrategy: 'distiller', fallbackReason: reason };
    }
  }

  const structured = await compactMessages(compactionContext, registry);
  work.assertCurrent();
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

const activeCompactions = new WeakMap<ConversationCompactionHost, OwnedJudgmentWork>();

export async function compactConversation(
  host: ConversationCompactionHost,
  registry: ProviderRegistry,
  modelId: string,
  trigger: 'auto' | 'manual' = 'manual',
  provider?: string,
  context?: CompactionContext,
): Promise<CompactionReceipt | undefined> {
  context?.signal?.throwIfAborted();
  context?.assertCurrent?.();
  if (host.getMessageCount() === 0) return undefined;
  activeCompactions.get(host)?.retire();
  let applied = false;
  let originalMessages: string | undefined;
  const contextRevision = JSON.stringify(context);
  const work = new OwnedJudgmentWork({ signal: context?.signal, assertCurrent: () => {
    context?.assertCurrent?.();
    if (JSON.stringify(context) !== contextRevision) throw new Error('Compaction context changed');
    if (activeCompactions.get(host) !== work) throw new Error('Conversation compaction was superseded');
    if (!applied && originalMessages !== undefined && JSON.stringify(host.getMessagesForLLM()) !== originalMessages) {
      throw new Error('Conversation changed during compaction');
    }
  } });
  activeCompactions.set(host, work);

  try {
    work.assertCurrent();
    const llmMessages = host.getMessagesForLLM();
    originalMessages = JSON.stringify(llmMessages);
    if (context && JSON.stringify(context.messages) !== originalMessages) {
      throw new Error('Conversation changed before compaction');
    }
    const compactionContext: CompactionContext = { ...(context ?? {
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
    }), signal: work.signal, assertCurrent: work.assertCurrent };
    // Select and run the compaction strategy. The distiller (fresh-context)
    // strategy falls back to structured, through the SAME quality scorer,
    // when its distillation is unavailable or scores below the floor; the
    // fallback is named on the receipt.
    const produced = await work.wait(() => produceCompaction(llmMessages, compactionContext, registry, work));
    work.assertCurrent();
    const { result } = produced;

    // Quality guard: score the compaction before committing it. A low-quality
    // result (e.g. no compression, or a destroyed handoff) is rejected, the
    // full conversation is kept and the failure is surfaced honestly rather
    // than silently swapping in a bad summary.
    const quality = await work.wait(() => scoreResult(llmMessages, result, compactionContext.contextWindow, work));
    work.assertCurrent();

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

    work.assertCurrent();
    host.replaceMessagesForLLM(result.messages);
    applied = true;
    const receipt: CompactionReceipt = { ...receiptBase, outcome: 'applied' };
    // Disposal during a host callback cannot undo already-applied messages.
    if (!work.current) return receipt;
    const memoryStore = host.getSessionMemoryStore();
    if (!work.current) return receipt;
    const memoriesCount = memoryStore?.list().length ?? 0;
    if (!work.current) return receipt;
    const memoriesPart = memoriesCount > 0 ? `, ${memoriesCount} pinned memories` : '';
    const saved = result.tokensBeforeEstimate - result.tokensAfterEstimate;
    const savedKTokens = Math.round(saved / 1000);
    const lineage = host.getSessionLineageTracker();
    if (!work.current) return receipt;
    lineage.addCompactionEntry(
      `${trigger} compact, saved ~${savedKTokens}K tokens${memoriesPart}.`,
    );

    if (!work.current) return receipt;
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

    return receipt;
  } catch (err: unknown) {
    if (!work.current || err instanceof CompactionQualityError) throw err;
    const msg = summarizeError(err);
    logger.error('Compact failed', { error: msg });
    throw err;
  } finally {
    if (activeCompactions.get(host) === work) activeCompactions.delete(host);
    work.retire();
  }
}
