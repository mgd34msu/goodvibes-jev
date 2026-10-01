/**
 * Consolidation proposals and run receipts (memory.consolidation.receipts, SDK 1.8.0's
 * consolidation-reaches-the-review-queue work). Idle/scheduled consolidation performs
 * only REVERSIBLE operations on its own (merge exact duplicates into a survivor, decay
 * never-referenced aged records); anything that needs a human call (a contradiction, a
 * cross-scope duplicate, a long-stale delete) is emitted as a PROPOSAL instead of
 * applied automatically. They are the first group on the Library's Review tab.
 *
 * The records a proposal references are already marked into the review queue by the
 * consolidation pass itself, so a proposal row only makes the proposal legible (what
 * kind, how many records, why) and selects it; its detail pane lists the records and
 * the queue rows they point at are highlighted. `route` on the wire is an internal
 * agent-tool invocation string, never a browser route or link.
 *
 * Honest states: a daemon build with no memory.consolidation.receipts id at all
 * (isMethodUnavailableError, 404) and a build that HAS the id but no consolidation
 * scheduler wired (isConsolidationUnavailableError, 501) both render the same honest
 * "not available" line, never blank space that reads as "nothing pending." Zero runs
 * ever having happened is a genuinely different, honest empty line.
 */
import { GitMerge } from 'lucide-react';
import type { MemoryConsolidationProposal } from '../../lib/goodvibes';
import { isConsolidationUnavailableError, isMethodUnavailableError } from '../../lib/errors';
import { Disclosure, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Row } from '../../components/ui/Row';
import { ErrorState } from '../../components/feedback/ErrorState';
import { formatRelative } from '../../lib/object';
import { includesText, useConsolidationReceipts } from '../library/library-data';

export const PROPOSAL_KIND_LABEL: Record<MemoryConsolidationProposal['kind'], string> = {
  contradiction: 'Contradiction',
  'cross-scope-duplicate': 'Cross-scope duplicate',
  'stale-delete': 'Stale, propose delete',
};

export function proposalKey(proposal: MemoryConsolidationProposal, index: number): string {
  return `${proposal.kind}-${proposal.ids.join(',')}-${index}`;
}

export function isConsolidationUnavailable(error: unknown): boolean {
  return isMethodUnavailableError(error) || isConsolidationUnavailableError(error);
}

interface ConsolidationProposalsProps {
  query?: string;
  selectedKey?: string | null;
  /** Select a proposal: the Review tab shows it in the detail pane and highlights its records. */
  onSelect: (key: string, proposal: MemoryConsolidationProposal) => void;
}

export function ConsolidationProposals({ query = '', selectedKey = null, onSelect }: ConsolidationProposalsProps) {
  const receipts = useConsolidationReceipts();
  const unavailable = receipts.isError && isConsolidationUnavailable(receipts.error);

  if (receipts.isPending) return <SkeletonRows count={2} label="Loading consolidation receipts" />;

  if (unavailable) {
    return (
      <p className="lib-quiet" data-testid="consolidation-receipts">
        This daemon does not run consolidation. The connected daemon build has no idle-time memory consolidation scheduler, so nothing is proposed here.
      </p>
    );
  }

  if (receipts.isError) {
    return <ErrorState error={receipts.error} onRetry={() => void receipts.refetch()} title="Consolidation receipts unavailable" />;
  }

  const pending = receipts.data.pendingProposals;
  const runs = receipts.data.receipts;
  const shown = pending
    .map((proposal, index) => ({ proposal, key: proposalKey(proposal, index) }))
    .filter(({ proposal }) => includesText([proposal.reason, PROPOSAL_KIND_LABEL[proposal.kind], ...proposal.ids], query));

  return (
    <div data-testid="consolidation-receipts">
      {shown.length > 0 && (
        <RowGroup label="Proposals" count={shown.length}>
          {shown.map(({ proposal, key }) => (
            <Row
              key={key}
              className="consolidation-proposal-row"
              leading={<GitMerge className="lib-row-icon" aria-hidden="true" />}
              title={proposal.reason}
              meta={`${PROPOSAL_KIND_LABEL[proposal.kind]} · ${proposal.ids.length} record${proposal.ids.length === 1 ? '' : 's'}`}
              selected={key === selectedKey}
              onSelect={() => onSelect(key, proposal)}
              trailing={<Button variant="outline" size="sm" onClick={() => onSelect(key, proposal)}>Resolve</Button>}
            />
          ))}
        </RowGroup>
      )}
      {pending.length === 0 && runs.length === 0 && (
        <p className="lib-quiet">No consolidation runs yet. This daemon has not run an idle or scheduled consolidation pass yet.</p>
      )}
      {pending.length === 0 && runs.length > 0 && (
        <p className="lib-quiet">Nothing currently pending a human call; every prior proposal has been resolved.</p>
      )}
    </div>
  );
}

/** The recorded consolidation runs, behind one quiet disclosure. */
export function ConsolidationRuns() {
  const receipts = useConsolidationReceipts();
  if (!receipts.isSuccess) return null;
  const runs = receipts.data.receipts;
  if (runs.length === 0) return null;

  return (
    <div className="consolidation-receipts-runs">
      <Disclosure summary={`${runs.length} run${runs.length === 1 ? '' : 's'} recorded`}>
        <ul className="lib-plain-list">
          {runs.map((receipt) => (
            <li key={receipt.runId} className="consolidation-run-row">
              <strong>{receipt.trigger}{receipt.idle ? ' (idle)' : ''}</strong>{' '}
              <span className="lib-quiet">{formatRelative(new Date(receipt.ranAt).getTime())}</span>
              <p className="lib-quiet">
                Scanned {receipt.scanned} · merged {receipt.merged.length} · archived {receipt.archived.length} ·
                decayed {receipt.decayed.length} · proposed {receipt.proposed.length}
              </p>
              {!receipt.usageSignalAvailable && (
                <p className="lib-quiet" role="note">
                  No usage instrumentation available for this run; decay ordering was best-effort.
                </p>
              )}
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
