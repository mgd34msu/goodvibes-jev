/** Picker display groups resolved from published repository family metadata. */
import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { ModelFamilyOption } from './batteries/model-family.js';
import { catalogModelsForReference } from './model-catalog-facts.js';

export type ModelFamily = ModelFamilyOption;
export interface ModelFamilyInput {
  readonly registryKey: string;
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
}

/** These are display labels for the repository's taxonomy, never model-ID guesses. */
const labels: Readonly<Record<string, ModelFamily>> = {
  claude: 'Claude', gpt: 'GPT', o: 'GPT', gemini: 'Gemini', gemma: 'Gemini', llama: 'Llama',
  qwen: 'Qwen', qvq: 'Qwen', glm: 'GLM', glmv: 'GLM', minimax: 'MiniMax', deepseek: 'DeepSeek',
  mistral: 'Mistral', ministral: 'Mistral', mixtral: 'Mistral', codestral: 'Mistral', devstral: 'Mistral',
  magistral: 'Mistral', pixtral: 'Mistral', command: 'Command', grok: 'Grok', kimi: 'Kimi',
};

function displayGroup(family: string): ModelFamily {
  const name = family.toLowerCase();
  for (const [root, label] of Object.entries(labels)) {
    if (name === root || (name.startsWith(root) && /^(?:[-.]|[0-9])/.test(name.slice(root.length)))) return label;
  }
  return 'Other';
}

export class ModelFamilyReadings {
  private readonly observed = new Map<string, ModelFamily | undefined>();

  /** Missing or conflicting repository facts leave the model ungrouped. */
  known(model: ModelFamilyInput): ModelFamily | undefined {
    try {
      const evidence = snapshotJudgmentInput(model) as ModelFamilyInput;
      const models = catalogModelsForReference(evidence.id, evidence.provider);
      if (models.length === 0 || models.some(record => !record.family)) return undefined;
      const groups = new Set(models.map(record => displayGroup(record.family!)));
      return groups.size === 1 ? groups.values().next().value : undefined;
    } catch (error) {
      if (error instanceof JudgmentInputError) return undefined;
      throw error;
    }
  }

  /** Compatibility entrypoint; local facts are available before this promise resolves. */
  async read(models: readonly ModelFamilyInput[]): Promise<boolean> {
    let changed = false;
    const failures: unknown[] = [];
    for (const model of models) {
      try {
        const evidence = snapshotJudgmentInput(model) as ModelFamilyInput;
        const family = this.known(evidence);
        changed ||= this.observed.get(evidence.registryKey) !== family;
        this.observed.set(evidence.registryKey, family);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
    return changed;
  }
}

export const modelFamilyReadings = new ModelFamilyReadings();
