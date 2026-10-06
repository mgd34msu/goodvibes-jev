import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSemanticAnswerInput } from './types.js';
import { KnowledgeEvidenceRelevanceHeldError as Held } from './evidence-ranking/types.js';

interface AnswerCandidateWindow {
  readonly sourceIds: ReadonlySet<string>;
  readonly nodeIds: ReadonlySet<string>;
  readonly factIds: ReadonlySet<string>;
  readonly assertCurrent: () => void;
}
const windows = new WeakMap<KnowledgeSemanticAnswerInput, {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: string;
  readonly window: AnswerCandidateWindow;
  readonly refreshAfterRepair?: (() => Promise<KnowledgeSemanticAnswerInput>) | undefined;
}>();

/** Internal local handoff from a completed typed retrieval pass. This is not a
 * serialized flag or new serving authority; it can only narrow later discovery.
 */
export function bindAnswerCandidateWindow(input: KnowledgeSemanticAnswerInput, store: KnowledgeStore,
  spaceId: string, sourceIds: readonly string[], nodeIds: readonly string[], factIds: readonly string[], assertCurrent: () => void,
  refreshAfterRepair?: () => Promise<KnowledgeSemanticAnswerInput>): void {
  assertCurrent();
  const sourceSnapshot = new Set(sourceIds), nodeSnapshot = new Set(nodeIds);
  const window = { sourceIds: sourceSnapshot, nodeIds: nodeSnapshot, factIds: new Set(factIds), assertCurrent };
  if (windows.has(input)) throw new Held('malformed');
  windows.set(input, { store, spaceId, query: input.query, window, refreshAfterRepair });
}

export function preparedAnswerCandidateWindow(input: KnowledgeSemanticAnswerInput, store: KnowledgeStore,
  spaceId: string): AnswerCandidateWindow | undefined {
  const known = windows.get(input);
  if (!known) return undefined;
  if (known.store !== store || known.spaceId !== spaceId || known.query !== input.query) throw new Held('stale');
  known.window.assertCurrent();
  return known.window;
}

/** Only the semantic service's existing successful foreground-repair transition
 * invokes a new retrieval pass. A stale or failed read never retries itself.
 */
export async function refreshAnswerCandidateWindowAfterRepair(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerInput> {
  const known = windows.get(input);
  if (!known?.refreshAfterRepair) return input;
  if (known.query !== input.query) throw new Held('stale');
  return known.refreshAfterRepair();
}
