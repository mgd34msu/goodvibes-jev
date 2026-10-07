import { assertProjectionExecution, captureProjectionArgs, type ToolInputProjector, type ToolInputProjectionRequest } from '../../tools/input-projection.js';
import type { ProtectedResearchReference, ProtectedSourceOwner, ResearchReferenceProjection, ResearchReferenceScreeningReceipt } from './types.js';
import { SOURCE_SCREENING_LIMITS } from './types.js';

interface ReferenceContext {
  readonly assertCurrent: () => void;
  readonly owner: ProtectedSourceOwner;
  readonly receipts: ReadonlyMap<string, ResearchReferenceScreeningReceipt>;
  readonly arguments: WeakSet<object>;
}

const contexts = new WeakMap<object, ReferenceContext>();
const fail = (): never => { throw new Error('Framed research references are unavailable'); };

/**
 * Resolve a declared reference only inside the body receiving this owner's
 * exact execution context and prepared arguments. This is reference access,
 * not a substitute for permission admission or complete source privacy.
 */
export function resolveFramedResearchReference(
  context: object | undefined,
  args: Record<string, unknown>,
  sourceId: string,
): ResearchReferenceProjection {
  const record = context ? contexts.get(context) : undefined;
  if (!record || !record.arguments.has(args)) return fail();
  assertProjectionExecution(context!, args);
  record.assertCurrent();
  const receipt = record.receipts.get(sourceId);
  if (!receipt) return fail();
  const projection = record.owner.projectResearchReference(receipt);
  // Source-authority callbacks may synchronously cancel the body's later
  // execution signal. Finish with a callback-free lifetime check.
  assertProjectionExecution(context!, args);
  return projection;
}

/**
 * Closed framing protocol: references is an ordered array of independently
 * declared { id: 'S1', url: completeUrl } cells. No prose spans are inferred.
 * Only those cells are projected; other argument fields are NOT privacy-cleared.
 * The registered schema/executor must support the resulting source labels.
 */
export function createFramedResearchReferenceProjector(owner: ProtectedSourceOwner): ToolInputProjector {
  return Object.freeze({
    async project(request: ToolInputProjectionRequest) {
      const { signal, assertCurrent: assertRequestCurrent } = request;
      assertRequestCurrent();
      const captured = captureProjectionArgs(request.args, request.name);
      const references = captured['references'];
      if (!Array.isArray(references) || references.length < 1 || references.length > SOURCE_SCREENING_LIMITS.sources) return fail();
      const originals = references.map((cell: unknown, index: number) => {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return fail();
        const value = cell as Record<string, unknown>;
        if (Object.keys(value).length !== 2 || value['id'] !== `S${index + 1}` || typeof value['url'] !== 'string') return fail();
        return value['url'];
      });
      const handles: ProtectedResearchReference[] = [];
      const receipts = new Map<string, ResearchReferenceScreeningReceipt>();
      const executionContext = Object.freeze({});
      const acceptedArguments = new WeakSet<object>();
      let released = false;
      let releasePromise: Promise<void> | undefined;
      const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        released = true;
        contexts.delete(executionContext);
        signal?.removeEventListener('abort', onAbort);
        releasePromise = Promise.allSettled(handles.map(handle => Promise.resolve().then(() => owner.release(handle)))).then(results => {
          receipts.clear();
          if (results.some(result => result.status === 'rejected')) throw new Error('Framed research reference cleanup failed');
        });
        return releasePromise;
      };
      const onAbort = () => { void release().catch(() => {}); };
      const assertExecutionCurrent = () => {
        if (released) return fail();
        signal?.throwIfAborted();
        for (const receipt of receipts.values()) owner.projectResearchReference(receipt);
      };
      const assertCurrent = () => { assertRequestCurrent(); assertExecutionCurrent(); };
      try {
        // Capture and preflight EVERY original/decoded name before the first
        // semantic request. No truncation or partial successful batch escapes.
        for (const original of originals) handles.push(owner.captureResearchReference(original));
        signal?.addEventListener('abort', onAbort, { once: true });
        assertCurrent();
        const projected: Array<Readonly<{ id: string; url?: string; urlOmitted?: true }>> = [];
        for (const [index, handle] of handles.entries()) {
          assertCurrent();
          const result = await owner.screenResearchReference(handle, { signal, assertCurrent: assertRequestCurrent });
          assertCurrent();
          if (result.status !== 'settled') {
            await release();
            return { status: 'held' as const };
          }
          const id = `S${index + 1}`;
          const projection = owner.projectResearchReference(result.receipt);
          receipts.set(id, result.receipt);
          // Preserve positions even when a complete reference is omitted.
          // URLs, paths, fragments and values never enter generic tool readers.
          projected.push(Object.freeze(projection.status === 'preserved'
            ? { id, url: `[source reference ${id}]` }
            : { id, urlOmitted: true as const }));
        }
        const referenceView = Object.freeze(projected);
        const serializedView = JSON.stringify(referenceView);
        // Admission's pre-claim guard becomes consumed when the body starts.
        // Resource reads retain their independent source lifetime/currentness;
        // they never try to mint or repeat the consumed execution claim.
        contexts.set(executionContext, { assertCurrent: assertExecutionCurrent, owner, receipts, arguments: acceptedArguments });
        return {
          status: 'projected' as const,
          args: Object.freeze({ ...captured, references: referenceView }),
          executionContext,
          assertCurrent,
          assertRepairedArgs(effective: Record<string, unknown>) {
            assertCurrent();
            if (JSON.stringify(effective['references']) !== serializedView) return fail();
            acceptedArguments.add(effective);
          },
          release,
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
  });
}
