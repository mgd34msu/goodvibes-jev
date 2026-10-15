import type { ModelCard } from '@typesafe-ai/sdk';
import { clientFor, requestWithoutDeadline, toJudgmentError } from './client.ts';
import { validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';

/** The model names an endpoint accepts (GET /v1/models). */
export interface ModelCatalog {
  list(): Promise<readonly ModelCard[]>;
}

/** A catalog of the models the configured endpoint accepts, with descriptions and release dates. */
export function createModelCatalog(input: JudgmentConfig): ModelCatalog {
  const config = { ...input, endpoint: { ...input.endpoint } };
  validateJudgmentConfig(config);
  const models = config.timeoutMs > 0 ? clientFor(config).models : undefined;
  return {
    async list() {
      try {
        if (models) return await models.list();
        const result = await requestWithoutDeadline(config, 'GET', '/v1/models', new AbortController().signal);
        if (!result || typeof result !== 'object' || !('models' in result) || !Array.isArray(result.models)
          || !result.models.every(model => model && typeof model.name === 'string')) {
          throw new JudgmentError('invalid-response', 'System One returned an invalid model catalog');
        }
        return result.models as ModelCard[];
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}

