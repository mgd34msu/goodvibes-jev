/** Shared, snapshot-bound family judgments for model picker surfaces. */
import { JudgmentPortMissingError, judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit, type JudgmentPort } from '@goodvibes-jev/judgment';
import { modelFamily, type ModelFamilyOption } from './batteries/model-family.js';

export type ModelFamily = ModelFamilyOption;
export interface ModelFamilyInput {
  readonly registryKey: string;
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
}

const SITE = 'runtime.model-picker.family';
const READ_CONCURRENCY = 8;

/** Exact evidence identity, including metadata replaced under the same registry key. */
function evidenceKey(model: ModelFamilyInput): string {
  return JSON.stringify([model.registryKey, model.id, model.displayName, model.provider]);
}

interface FamilyCache {
  readonly families: Map<string, ModelFamily | undefined>;
  readonly inFlight: Map<string, Promise<boolean>>;
}

/**
 * Display-only readings shared within one installed judgment-port authority.
 * There is no caller abort signal: a closed picker drops its own completion,
 * never another surface's shared read. Replacing the port isolates its cache.
 */
export class ModelFamilyReadings {
  private readonly caches = new WeakMap<JudgmentPort, FamilyCache>();

  private cache(port: JudgmentPort): FamilyCache {
    let cache = this.caches.get(port);
    if (!cache) {
      cache = { families: new Map(), inFlight: new Map() };
      this.caches.set(port, cache);
    }
    return cache;
  }

  /** Undefined means unread, failed or unsettled, never an inferred Other verdict. */
  known(model: ModelFamilyInput): ModelFamily | undefined {
    try {
      return this.cache(judgmentPort(SITE)).families.get(evidenceKey(model));
    } catch (error) {
      if (error instanceof JudgmentPortMissingError) return undefined;
      throw error;
    }
  }

  /**
   * Read exact catalog evidence once. Concurrent consumers join pending work;
   * settled and unsettled outcomes are remembered, while failures can retry.
   */
  async read(models: readonly ModelFamilyInput[]): Promise<boolean> {
    if (models.length === 0) return false;
    const port = judgmentPort(SITE);
    const cache = this.cache(port);
    const evidence = models.map((model) => ({ ...model }));
    const failures: unknown[] = [];
    const results = await mapLimit(evidence, READ_CONCURRENCY, async (model) => {
      try {
        return await this.readOne(model, port, cache);
      } catch (error) {
        failures.push(error);
        return false;
      }
    });
    // Drain successful siblings before returning control to a rendering caller.
    // Otherwise a first failure can strand their later results without a repaint.
    if (failures.length > 0) throw failures[0];
    return results.some(Boolean);
  }

  private readOne(model: ModelFamilyInput, port: JudgmentPort, cache: FamilyCache): Promise<boolean> {
    const key = evidenceKey(model);
    const pending = cache.inFlight.get(key);
    if (pending) return pending;
    if (cache.families.has(key)) return Promise.resolve(false);
    const reading = Promise.resolve().then(async () => {
      const run = await modelFamily.run(port, {
        id: model.id, displayName: model.displayName, provider: model.provider,
      }, { site: SITE });
      const result = run.readings.family;
      const family = result.outcome === 'act' ? result.choice : undefined;
      run.recordAction(family ?? 'unsettled');
      cache.families.set(key, family);
      return family !== undefined;
    }).finally(() => { cache.inFlight.delete(key); });
    cache.inFlight.set(key, reading);
    return reading;
  }
}

/** Shared by server projections and in-process picker surfaces. */
export const modelFamilyReadings = new ModelFamilyReadings();
