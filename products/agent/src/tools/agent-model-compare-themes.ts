import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { captureOwnedJson, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { modelReasonTheme, MODEL_REASON_THEME_LABELS, routingRegistry, type ModelReasonTheme } from '@goodvibes-jev/engine/sdk/platform/routing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { toJson, type YesNoReading } from '@goodvibes-jev/judgment';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, assertModelReadingInputCurrent, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import type { AgentModelCompareArtifactStore, LoadedComparisonJudgment } from './agent-model-compare-types.ts';

export type ComparisonThemeReading =
  | { readonly status: 'held' }
  | { readonly status: 'settled'; readonly themes: readonly ModelReasonTheme[];
      readonly readings: Readonly<Record<ModelReasonTheme, YesNoReading>>;
      readonly provenance: { readonly battery: string; readonly version: number; readonly model: string; readonly requestId: string | undefined; readonly decisionId: string | undefined } };

/** Keep complete authored metadata. Filesystem transport locations are not evidence. */
function artifactEvidence(record: unknown): unknown {
  const captured = captureOwnedJson(record);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw new ToolInputProjectionError('held');
  return Object.fromEntries(Object.entries(captured).filter(([key]) => key !== 'contentPath' && key !== 'metadataPath'));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputProjectionError('held');
  return value as Record<string, unknown>;
}

/** One six-question call per judgment, only after every original source is preserved by its owner. */
export async function readComparisonReasonThemes(judgment: LoadedComparisonJudgment,
  store: AgentModelCompareArtifactStore | undefined, report: unknown, options: ModelReadingOptions): Promise<ComparisonThemeReading> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  try {
    if (!store || !judgment.sourceArtifactId || !options.sourceOwner) return { status: 'held' };
    const storeCurrent = captureCatalogMethods(store, ['readContent', 'get', 'list']);
    const readContent = store.readContent;
    if (typeof readContent !== 'function') return { status: 'held' };
    const ownerCurrent = captureCatalogMethods(options.sourceOwner, ['capture', 'screen', 'project', 'release']);
    const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); storeCurrent(); ownerCurrent(); };
    const load = async (id: string, json: boolean) => {
      current(); const { record, buffer } = await readContent.call(store, id); current();
      if (record.id !== id || buffer.byteLength > 1_000_000) throw new ToolInputProjectionError('held');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { artifact: artifactEvidence(record), content: json ? JSON.parse(text) as unknown : text };
    };
    const originalJudgment = await load(judgment.artifact.artifactId, true);
    const savedJudgment = object(originalJudgment.content);
    if (savedJudgment.schema !== 'goodvibes.agent.model_compare_judgment.v1'
      || savedJudgment.judgmentId !== judgment.judgmentId || savedJudgment.comparisonId !== judgment.comparisonId
      || savedJudgment.sourceArtifactId !== judgment.sourceArtifactId || savedJudgment.winnerBlindId !== judgment.winnerBlindId
      || savedJudgment.reasons !== judgment.reasons || savedJudgment.notes !== judgment.notes) throw new ToolInputProjectionError('held');
    const originalComparison = await load(judgment.sourceArtifactId, true);
    const comparison = object(originalComparison.content);
    if (comparison.schema !== 'goodvibes.agent.model_compare.v1' || comparison.comparisonId !== judgment.comparisonId
      || typeof comparison.prompt !== 'string' || !Array.isArray(comparison.candidates)
      || !comparison.candidates.some(candidate => object(candidate).blindId === judgment.winnerBlindId)) throw new ToolInputProjectionError('held');
    const sourceReference = comparison.sourceArtifact == null ? undefined : object(comparison.sourceArtifact);
    if (sourceReference && typeof sourceReference.artifactId !== 'string') throw new ToolInputProjectionError('held');
    const originalSource = sourceReference ? await load(sourceReference.artifactId as string, false) : null;
    const source = { judgment, comparison, originalJudgment, originalComparison, originalSource, report };
    return await withModelReadingSource(source, { ...options, assertCurrent: current }, async (state, scoped): Promise<ComparisonThemeReading> => {
      scoped.assertCurrent?.();
      const methodsCurrent = captureCatalogMethods(modelReasonTheme, ['run', 'name', 'version', 'model', 'accuracyFloor', 'items']);
      if (routingRegistry.get('agent.models.reason-theme') !== modelReasonTheme) throw new ToolInputProjectionError('held');
      const definition = () => ({ name: modelReasonTheme.name, version: modelReasonTheme.version, model: modelReasonTheme.model,
        accuracyFloor: modelReasonTheme.accuracyFloor, items: modelReasonTheme.items });
      const definitionBytes = JSON.stringify(captureModelReadingInput(definition()));
      const definitionCurrent = () => {
        methodsCurrent();
        if (routingRegistry.get(modelReasonTheme.name) !== modelReasonTheme) throw new ToolInputProjectionError('held');
        assertModelReadingInputCurrent(definition(), definitionBytes);
      };
      const port = captureJudgmentPort(modelReasonTheme.name, { signal: scoped.signal,
        assertCurrent: () => { scoped.assertCurrent?.(); definitionCurrent(); }, prepareResultCapture: prepareJudgmentResult });
      // Interface-shaped artifact records lack a JSON index signature. The owner
      // already admitted the complete immutable tree; serialize that same tree.
      const wireState = toJson(state);
      if (!wireState || typeof wireState !== 'object' || Array.isArray(wireState)) throw new ToolInputProjectionError('held');
      const run = await modelReasonTheme.run(port.port, wireState, { site: modelReasonTheme.name, signal: port.signal });
      port.assertCurrent();
      if (run.result.model !== modelReasonTheme.model || run.result.requestedModel !== modelReasonTheme.model) throw new ToolInputProjectionError('held');
      const names = Object.keys(MODEL_REASON_THEME_LABELS) as ModelReasonTheme[];
      const settled = names.every(name => run.readings[name].outcome === 'act');
      const themes = settled ? names.filter(name => run.readings[name].verdict === 'yes') : [];
      run.recordAction(settled ? themes.length ? `classified preference themes: ${themes.join(', ')}` : 'uncategorized affirmative preference' : 'held preference theme classification');
      port.assertCurrent();
      const restriction = port.consumeObservation();
      scoped.retainCurrent?.(restriction.assertCurrent, modelReasonTheme.name + ':port');
      scoped.retainCurrent?.(definitionCurrent, modelReasonTheme.name + ':definition');
      if (!settled) return { status: 'held' };
      return { status: 'settled', themes, readings: run.readings,
        provenance: { battery: modelReasonTheme.name, version: modelReasonTheme.version, model: run.result.model,
          requestId: run.result.requestId, decisionId: run.result.decisionId } };
    });
  } catch {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    return { status: 'held' };
  }
}
