import { AlertTriangle, Info } from 'lucide-react';
import type { MemorySearchResult } from '../../lib/goodvibes';
import { Chip } from '../../components/ui/Chip';

/**
 * The recall-honesty contract, surfaced verbatim (memory-recall-contract.ts, promoted
 * onto the wire by memory.records.search). Three things this MUST NEVER do:
 *   1. Hide `indexUnavailableReason`, a silent empty result here would read as
 *      "nothing was ever stored" when the truth is "the semantic index couldn't be
 *      consulted, so this fell back to a literal scan". Shown verbatim, unparaphrased.
 *   2. Hide `caveat`, the softer "ran on the hashed-only fallback provider" note.
 *   3. Hide the recall-filter exclusion counts when `recallFiltered` is true, a
 *      caller who asked "what would the agent actually see" needs to know how many
 *      records were excluded and why, not just the surviving count.
 *
 * `totalBeforeRecallFilter` is NOT "every record that matches", it is
 * `baseRecords.length` from `runHonestMemorySearch` (memory-recall-contract.ts), i.e.
 * whatever the underlying search returned, which is itself capped at the caller's own
 * `limit`. `limit` is the exact `limit` this component's caller searched with, so the
 * label says "of the first N" instead of implying N is the whole matching set.
 *
 * The recall floor itself travels on the wire as `result.recallFloor`; the label
 * states it directly from that value, never a hardcoded percentage.
 */
export function MemorySearchHonestyNote({ result, limit }: { result: MemorySearchResult; limit?: number }) {
  return (
    <div className="lib-honesty" aria-live="polite">
      <div className="lib-honesty__mode">
        <Chip size="sm">{result.mode === 'semantic' ? 'Semantic search' : 'Literal search'}</Chip>
      </div>

      {result.indexUnavailableReason !== null && (
        <div className="dv-notice dv-notice--warn lib-honesty__banner--degraded" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{result.indexUnavailableReason}</span>
        </div>
      )}

      {result.caveat !== null && (
        <div className="dv-notice lib-honesty__banner--caveat" role="status">
          <Info aria-hidden="true" />
          <span>{result.caveat}</span>
        </div>
      )}

      {result.recallFiltered && (
        <p className="lib-honesty__stats">
          {result.records.length} shown after the recall filter
          {' · '}{result.excludedFlaggedCount} excluded (flagged stale/contradicted)
          {' · '}{result.excludedBelowFloorCount} excluded (below the {result.recallFloor}% recall floor)
          {' · '}{result.totalBeforeRecallFilter} {typeof limit === 'number' ? `of the first ${limit} matches` : 'total'} before the recall filter
        </p>
      )}
    </div>
  );
}
