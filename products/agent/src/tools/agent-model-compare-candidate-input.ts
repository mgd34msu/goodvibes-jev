import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError, type ToolInputProjectionRequest, type ToolInputProjector, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createComparisonOperation } from './agent-model-compare-operation.ts';
import type { AgentModelCompareToolDeps } from './agent-model-compare-types.ts';

const clearedRequests = new WeakMap<object, () => void>();
export function assertComparisonCandidateSource(args: Record<string, unknown>): void {
  const assertCurrent = clearedRequests.get(args);
  if (!assertCurrent) throw new ToolInputProjectionError('held');
  assertCurrent();
}

/** Whole values retain their key paths when the complete source needs several batches. */
function sourceBatches(source: unknown): readonly (readonly string[])[] {
  const serialized = JSON.stringify(source);
  if (typeof serialized !== 'string' || serialized.length > 1_000_000) throw new ToolInputProjectionError('held');
  const parts: string[] = [];
  const collect = (value: unknown, path: readonly string[]) => {
    const part = path.length ? JSON.stringify({ path, value }) : serialized;
    if (part.length <= SOURCE_SCREENING_LIMITS.characters) { parts.push(part); return; }
    if (!value || typeof value !== 'object' || !Object.keys(value).length) throw new ToolInputProjectionError('held');
    for (const [key, entry] of Object.entries(value)) collect(entry, [...path, key]);
  };
  collect(source, []);
  const batches: string[][] = [];
  let size = 0, total = 0;
  for (const part of parts) {
    total += part.length;
    if (total > 1_000_000) throw new ToolInputProjectionError('held');
    let batch = batches.at(-1);
    if (!batch || batch.length >= SOURCE_SCREENING_LIMITS.parts || size + part.length > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch); size = 0;
    }
    batch.push(part); size += part.length;
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  return batches;
}

/** The registered owner clears the actual request and private source before hosted admission. */
export function createComparisonCandidateProjector(registry: ToolRegistry, deps: AgentModelCompareToolDeps): ToolInputProjector {
  return Object.freeze({ async project(request: ToolInputProjectionRequest) {
    if (deps.toolRegistry !== registry) throw new ToolInputProjectionError('held');
    const operation = createComparisonOperation(deps, request.args,
      { signal: request.signal, assertCurrent: request.assertCurrent });
    const owner = operation.sourceOwner;
    if (!owner) throw new ToolInputProjectionError('unconfigured');
    const assertOwner = captureCatalogMethods(owner, ['capture', 'screen', 'project', 'release']);
    const capture = owner.capture, screen = owner.screen, project = owner.project, releaseHandle = owner.release;
    operation.assertCurrent();
    const captured = captureModelReadingInput(request.args);
    if (typeof captured.modelId !== 'string' || typeof captured.providerId !== 'string') throw new ToolInputProjectionError('held');
    const modelId = captured.modelId, providerId = captured.providerId;
    const provider = deps.providerRegistry.getForModel(modelId, providerId);
    const assertProvider = captureCatalogMethods(provider, ['chat']);
    const assertProviderCurrent = () => {
      assertProvider();
      if (deps.providerRegistry.getForModel(modelId, providerId) !== provider) throw new ToolInputProjectionError('held');
      assertProvider(); operation.assertCurrent();
    };
    assertProviderCurrent();
    let source: unknown;
    if (typeof captured.sourceArtifactId === 'string' && captured.sourceArtifactId) {
      if (!operation.deps.artifactStore?.readContent) throw new ToolInputProjectionError('unavailable');
      const acquired = await operation.deps.artifactStore.readContent(captured.sourceArtifactId);
      operation.assertCurrent();
      source = { record: acquired.record, content: acquired.buffer.toString('utf8') };
    }
    const complete = captureModelReadingInput({ request: captured, ...(source === undefined ? {} : { source }) });
    const batches = sourceBatches(complete);
    const serializedArgs = JSON.stringify(captured);
    const handles: ProtectedSource[] = [];
    const receipts: Array<{ receipt: SourceScreeningReceipt; parts: readonly string[] }> = [];
    let released = false, releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (releasing) return releasing;
      released = true; request.signal?.removeEventListener('abort', abort);
      releasing = Promise.allSettled(handles.map(handle => Promise.resolve().then(() => releaseHandle.call(owner, handle)))).then(results => {
        if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
      });
      return releasing;
    };
    const abort = () => { void release().catch(() => {}); };
    const assertCurrent = () => {
      if (released) throw new ToolInputProjectionError('held');
      operation.assertCurrent(); assertOwner(); assertProviderCurrent();
      for (const { receipt, parts } of receipts) {
        const projected = project.call(owner, receipt);
        if (projected.length !== parts.length || projected.some((part, index) => part !== parts[index])) throw new ToolInputProjectionError('held');
      }
      operation.assertCurrent(); assertOwner(); assertProviderCurrent(); request.signal?.throwIfAborted();
      if (released) throw new ToolInputProjectionError('held');
    };
    try {
      request.signal?.addEventListener('abort', abort, { once: true });
      assertCurrent();
      for (const parts of batches) { assertCurrent(); handles.push(capture.call(owner, parts)); assertCurrent(); }
      for (const [index, handle] of handles.entries()) {
        assertCurrent(); const screened = await screen.call(owner, handle); assertCurrent();
        if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
        receipts.push({ receipt: screened.receipt, parts: batches[index]! }); assertCurrent();
      }
      return { status: 'projected' as const, args: captured, assertCurrent, release,
        assertRepairedArgs(args: Record<string, unknown>) {
          const assertBound = () => {
            assertCurrent();
            if (JSON.stringify(captureModelReadingInput(args)) !== serializedArgs) throw new ToolInputProjectionError('held');
          };
          assertBound(); clearedRequests.set(args, assertBound);
        },
      };
    } catch (error) { await release(); throw error; }
  } });
}
