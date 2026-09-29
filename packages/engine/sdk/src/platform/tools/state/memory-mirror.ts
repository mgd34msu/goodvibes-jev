/**
 * The state tool's mirror of `mode=memory action=set` writes into the retrievable memory store
 * (see mirrorMemoryRecord), and the reading that files a new record under its memory class.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { MemoryRegistry } from '../../state/memory-registry.js';
import type { MemoryClass, ProvenanceLink } from '../../state/memory-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { memoryClass, memoryClassView } from '../batteries/memory-class.js';

const MEMORY_CLASS_SITE = 'tools.state.memory-class';

/** The class a new mirrored memory record is filed under (see mirrorMemoryRecord). */
async function readMemoryClass(key: string, value: string): Promise<MemoryClass> {
  const run = await memoryClass.run(judgmentPort(MEMORY_CLASS_SITE), memoryClassView(key, value), { site: MEMORY_CLASS_SITE });
  const reading = run.readings.memory_class;
  const cls: MemoryClass = reading.outcome === 'escalate' ? 'fact' : reading.choice;
  run.recordAction(`filed as ${cls}`);
  return cls;
}

/** What mirroring one memory write does: update the key's existing record, or add a record of this class. */
export type MemoryMirrorPlan = { readonly existingId: string; readonly tags: string[] } | { readonly cls: MemoryClass };

/**
 * Plan the mirror of a `mode=memory action=set` write before the flat file is written: find the
 * key's existing record, or read the class a new record is filed under with
 * `engine.tools.memory-class` (tools/batteries/memory-class.ts). A reading that acts or confirms
 * files it under that class, one that escalates files it as `fact`; an updated record keeps its
 * class. Undefined when there is no registry or it cannot be read (mirroring is best-effort). A
 * JudgmentError from the reading propagates, so the set fails before anything is written.
 */
export async function planMemoryMirror(memoryRegistry: MemoryRegistry | undefined, safeKey: string, value: string): Promise<MemoryMirrorPlan | undefined> {
  if (!memoryRegistry) return undefined;
  let existing: { id: string; tags: string[] } | undefined;
  try {
    existing = memoryRegistry.getAll().find((record) => record.tags.includes(`state-memory:${safeKey}`));
  } catch (err) {
    logger.warn('state tool: memory registry unreadable, write not mirrored (flat-file write unaffected)', { key: safeKey, error: summarizeError(err) });
    return undefined;
  }
  return existing ? { existingId: existing.id, tags: existing.tags } : { cls: await readMemoryClass(safeKey, value) };
}

/**
 * Mirror a `mode=memory action=set` write into a retrievable `memory_records` row so passive
 * per-turn knowledge injection (which only reads `memory_records`, never the flat
 * `.goodvibes/memory/*.json` files) can surface it. This closes the trust gap where a distilled
 * preference lived only as a flat file that retrieval never saw.
 *
 * Deduped per key via a stable `state-memory:<key>` tag, so repeated statements of the same
 * preference UPDATE the single record instead of piling up duplicates. Provenance is a `file` link
 * back to the flat-file twin (honest about where the record came from). The record enters at
 * reviewState 'fresh' with default confidence, visible to retrieval (the confidence>=55 gate) but
 * NOT stamped 'reviewed'/high-trust, so a self-recorded preference cannot inject itself at unearned
 * trust; the existing confidence-floor/review flow governs it from there.
 *
 * Best-effort: returns true when a record was written, false when there is no plan or the write
 * failed, the caller's flat-file write (the source of truth for `mode=memory list/get`) is
 * unaffected either way.
 */
export async function mirrorMemoryRecord(
  memoryRegistry: MemoryRegistry | undefined,
  safeKey: string,
  value: string,
  plan: MemoryMirrorPlan | undefined,
): Promise<boolean> {
  if (!memoryRegistry || !plan) return false;
  try {
    const flat = value.replace(/\s+/g, ' ').trim();
    const summary = flat.length > 160 ? `${flat.slice(0, 157)}...` : (flat || safeKey);
    const provenance: ProvenanceLink[] = [
      { kind: 'file', ref: `.goodvibes/memory/${safeKey}.json`, label: `state tool memory (${safeKey})` },
    ];
    if ('existingId' in plan) {
      memoryRegistry.update(plan.existingId, { summary, detail: value, tags: plan.tags });
    } else {
      await memoryRegistry.add({
        scope: 'project',
        cls: plan.cls,
        summary,
        detail: value,
        tags: ['state-memory', `state-memory:${safeKey}`],
        provenance,
        review: { state: 'fresh' },
      });
    }
    return true;
  } catch (err) {
    logger.warn('state tool: memory record mirror failed (flat-file write unaffected)', {
      key: safeKey,
      error: summarizeError(err),
    });
    return false;
  }
}
