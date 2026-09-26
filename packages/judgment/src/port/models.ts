import type { ModelCard } from '@typesafe-ai/sdk';
import { clientFor, toJudgmentError } from './client.ts';
import type { JudgmentConfig } from './config.ts';

/** The model names an endpoint accepts (GET /v1/models). */
export interface ModelCatalog {
  list(): Promise<readonly ModelCard[]>;
}

/** A catalog of the models the configured endpoint accepts, with descriptions and release dates. */
export function createModelCatalog(config: JudgmentConfig): ModelCatalog {
  const { models } = clientFor(config);
  return {
    async list() {
      try {
        return await models.list();
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}

