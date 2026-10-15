import { assertCurrentToolEffect, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import { runCandidate, listSelectableModels, parseArtifactCandidate } from './agent-model-compare-run.ts';
import { type AgentModelCompareToolDeps, type CompareCandidateResult, type ResolvedCompareModel } from './agent-model-compare-types.ts';
import { assertComparisonCandidateSource, createComparisonCandidateProjector } from './agent-model-compare-candidate-input.ts';

const NAME = 'agent_model_compare_candidate';
let sequence = 0;

/** Concrete metered requests are admitted with their complete transmitted arguments. */
export function registerComparisonCandidate(registry: ToolRegistry, deps: AgentModelCompareToolDeps): void {
  if (registry.has(NAME)) return;
  const candidate: Tool = {
    definition: { name: NAME, description: 'Run one metered blind-comparison candidate using an exact model and bounded output.', sideEffects: ['network'], concurrency: 'parallel', parameters: {
      type: 'object', properties: {
        registryKey: { type: 'string' }, modelId: { type: 'string' }, providerId: { type: 'string' }, blindId: { type: 'string' },
        prompt: { type: 'string' }, systemPrompt: { type: 'string' }, maxTokens: { type: 'integer', minimum: 0 },
        metered: { type: 'boolean', const: true },
        comparisonRequest: { type: 'object', additionalProperties: true }, sourceArtifactId: { type: 'string' },
      }, required: ['registryKey', 'modelId', 'providerId', 'blindId', 'prompt', 'systemPrompt', 'maxTokens', 'metered', 'comparisonRequest'], additionalProperties: false,
    } },
    async execute(args, options) {
      const assertSend = () => { options?.signal?.throwIfAborted(); assertComparisonCandidateSource(args); if (!assertCurrentToolEffect(args, options, 'send')) throw new Error('Metered comparison requires current recorded send admission.'); };
      try {
        assertSend();
        const { registryKey, modelId, providerId, blindId, prompt, systemPrompt, maxTokens } = args;
        if (typeof registryKey !== 'string' || typeof modelId !== 'string' || typeof providerId !== 'string' || typeof blindId !== 'string'
          || typeof prompt !== 'string' || typeof systemPrompt !== 'string' || typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens)
          || maxTokens < 0 || args.metered !== true) {
          return { success: false, error: 'Invalid comparison request.' };
        }
        const models = await listSelectableModels(deps.modelCatalog);
        assertSend();
        const model = models.find(item => item.registryKey === registryKey && item.modelId === modelId && item.providerId === providerId);
        if (!model) return { success: false, error: 'Comparison model is no longer selectable.' };
        const result = await runCandidate(deps, model, blindId, prompt, systemPrompt, maxTokens, assertSend, options?.signal);
        assertSend();
        return { success: true, output: JSON.stringify(result) };
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Comparison candidate was held.' }; }
    },
  };
  registry.register(candidate, { inputProjection: createComparisonCandidateProjector(registry, deps) });
}

export async function runAdmittedComparisonCandidate(registry: ToolRegistry | undefined, options: ToolExecuteOptions | undefined,
  model: ResolvedCompareModel, blindId: string, prompt: string, systemPrompt: string, maxTokens: number, assertCurrent: () => void,
  comparisonRequest: Record<string, unknown>, sourceArtifactId?: string): Promise<CompareCandidateResult> {
  if (!registry) throw new Error('Metered comparison requires its owning tool registry.');
  const result = await registry.executeNested(`comparison-candidate-${++sequence}`, NAME, {
    registryKey: model.registryKey, modelId: model.modelId, providerId: model.providerId, blindId, prompt, systemPrompt, maxTokens, metered: true,
    comparisonRequest, ...(sourceArtifactId ? { sourceArtifactId } : {}),
  }, options, { assertCurrent, signal: options?.signal });
  if (!result.success || typeof result.output !== 'string') throw new Error(result.error || 'Comparison candidate was not admitted.');
  const parsed: unknown = JSON.parse(result.output);
  const candidate = parseArtifactCandidate(parsed, 0);
  if (!candidate || candidate.blindId !== blindId || candidate.model.registryKey !== model.registryKey
    || candidate.model.modelId !== model.modelId || candidate.model.providerId !== model.providerId) throw new Error('Comparison candidate result does not match its exact request.');
  return candidate;
}
