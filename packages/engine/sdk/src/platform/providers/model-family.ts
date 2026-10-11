/** Shared, snapshot-bound family judgments for model picker surfaces. */
import { JudgmentAuthorityRetiredError, JudgmentPortMissingError, captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit, type JudgmentPort } from '@goodvibes-jev/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
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
 * Display-only readings shared within one installed/source judgment authority.
 * There is no caller abort signal: a closed picker drops its own completion,
 * never another surface's shared read. Replacing the port isolates its cache.
 */
export class ModelFamilyReadings {
  private readonly caches = new WeakMap<object, FamilyCache>();

  private cache(identity: object): FamilyCache {
    let cache = this.caches.get(identity);
    if (!cache) {
      cache = { families: new Map(), inFlight: new Map() };
      this.caches.set(identity, cache);
    }
    return cache;
  }

  /** Undefined means unread, failed or unsettled, never an inferred Other verdict. */
  known(model: ModelFamilyInput): ModelFamily | undefined {
    try {
      // Screen the complete original even on cache hits: a caller can replace
      // non-projected metadata while retaining the same family evidence key.
      const evidence = snapshotJudgmentInput(model) as ModelFamilyInput;
      const source = captureJudgmentPort(SITE);
      const family = this.cache(source.identity).families.get(evidenceKey(evidence));
      source.assertCurrent();
      return family;
    } catch (error) {
      if (error instanceof JudgmentInputError || error instanceof JudgmentPortMissingError || error instanceof JudgmentAuthorityRetiredError) return undefined;
      throw error;
    }
  }

  /**
   * Read exact catalog evidence once. Concurrent consumers join pending work;
   * settled and unsettled outcomes are remembered, while failures can retry.
   */
  async read(models: readonly ModelFamilyInput[]): Promise<boolean> {
    if (models.length === 0) return false;
    // Capture and screen every complete original before projection, cache keys,
    // port access or recording. Never spread borrowed fields before this floor.
    // Refused models remain ungrouped without stranding valid sibling readings.
    const evidence: ModelFamilyInput[] = [];
    const failures: unknown[] = [];
    for (const model of models) {
      try { evidence.push(snapshotJudgmentInput(model) as ModelFamilyInput); }
      catch (error) { failures.push(error); }
    }
    if (evidence.length === 0) throw failures[0];
    const source = captureJudgmentPort(SITE);
    const port = source.port;
    const cache = this.cache(source.identity);
    source.assertCurrent();
    const results = await mapLimit(evidence, READ_CONCURRENCY, async (model) => {
      try {
        source.assertCurrent();
        return await this.readOne(model, port, cache, source.assertCurrent);
      } catch (error) {
        failures.push(error);
        return false;
      }
    });
    // Drain successful siblings before returning control to a rendering caller.
    // Otherwise a first failure can strand their later results without a repaint.
    if (failures.length > 0) throw failures[0];
    source.assertCurrent();
    return results.some(Boolean);
  }

  private readOne(model: ModelFamilyInput, port: JudgmentPort, cache: FamilyCache, assertCurrent: () => void): Promise<boolean> {
    assertCurrent();
    const key = evidenceKey(model);
    const pending = cache.inFlight.get(key);
    if (pending) return pending;
    if (cache.families.has(key)) return Promise.resolve(false);
    const reading = Promise.resolve().then(async () => {
      assertCurrent();
      const run = await modelFamily.run(port, {
        id: model.id, displayName: model.displayName, provider: model.provider,
      }, { site: SITE });
      assertCurrent();
      const result = run.readings.family;
      const family = result.outcome === 'act' ? result.choice : undefined;
      run.recordAction(family ?? 'unsettled');
      assertCurrent();
      cache.families.set(key, family);
      return family !== undefined;
    }).finally(() => { cache.inFlight.delete(key); });
    cache.inFlight.set(key, reading);
    return reading;
  }
}

/** Shared by server projections and in-process picker surfaces. */
export const modelFamilyReadings = new ModelFamilyReadings();
