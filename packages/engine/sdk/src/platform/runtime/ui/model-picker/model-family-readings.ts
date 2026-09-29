/**
 * The model picker's family readings: which maker's family each model
 * belongs to, read by `engine.runtime.model-family` once per registry key and
 * remembered for the life of the process. A model not yet read has no family
 * in the picker until its reading lands; a reading that does not settle leaves
 * it without one and is not asked again.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import type { ModelDefinition } from '../../../providers/registry.js';
import { modelFamily } from './batteries/model-family.js';
import type { ModelFamily } from './types.js';

const SITE = 'runtime.model-picker.family';

/** Model family readings in flight at once. */
const READ_CONCURRENCY = 8;

export class ModelFamilyReadings {
  private readonly families = new Map<string, ModelFamily | undefined>();
  private readonly inFlight = new Set<string>();

  /** The family read for a model, or undefined when it is unread or did not settle. */
  known(model: Pick<ModelDefinition, 'registryKey'>): ModelFamily | undefined {
    return this.families.get(model.registryKey);
  }

  /**
   * Reads every model not read or being read. Resolves true when any model
   * gained a family, so the caller can rebuild what it shows. A read that
   * throws leaves its model unread.
   */
  async read(models: readonly Pick<ModelDefinition, 'registryKey' | 'id' | 'displayName' | 'provider'>[]): Promise<boolean> {
    const unread = models.filter((model) => !this.families.has(model.registryKey) && !this.inFlight.has(model.registryKey));
    if (unread.length === 0) return false;
    for (const model of unread) this.inFlight.add(model.registryKey);
    try {
      const port = judgmentPort(SITE);
      const read = await mapLimit(unread, READ_CONCURRENCY, async (model) => {
        const run = await modelFamily.run(port, { id: model.id, displayName: model.displayName, provider: model.provider }, { site: SITE });
        const reading = run.readings.family;
        const family = reading.outcome === 'act' ? reading.choice : undefined;
        run.recordAction(family ?? 'unsettled');
        this.families.set(model.registryKey, family);
        return family !== undefined;
      });
      return read.some(Boolean);
    } finally {
      for (const model of unread) this.inFlight.delete(model.registryKey);
    }
  }
}

/** The process's model family readings, shared by every picker surface. */
export const modelFamilyReadings = new ModelFamilyReadings();
