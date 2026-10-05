import { useEffect } from 'react';
import type { ClientLifetime } from '../../lib/client-lifetime';
import { useContractCancellation } from '../../hooks/useContractCancellation';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useContractDetail } from '../../hooks/useContracts';
import { nonEmpty } from '../../lib/non-empty';
import { errorCode, formatError, isMethodUnavailableError } from '../../lib/errors';
import { DetailPane, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { ContractTree } from './ContractTree';

export function ContractDetail({ id, lifetime, live, onClose, onOpenProcess }: {
  id: string;
  lifetime: ClientLifetime;
  live: boolean;
  onClose: () => void;
  onOpenProcess?: () => void;
}) {
  const query = useContractDetail(lifetime, id, live);
  const cancellation = useContractCancellation(lifetime, id);
  // Errors take precedence over a previously cached tree. Failed refreshes must
  // not make stale evidence look like the daemon's current judgment.
  const contract = query.isError ? undefined : query.data;
  const cancellable = contract && !['passed', 'failed', 'cancelled'].includes(contract.status);
  // A failed read or a newly terminal record withdraws an unsubmitted intent.
  const { dismiss } = cancellation;
  useEffect(() => { if (!cancellable) dismiss(); }, [cancellable, dismiss]);
  const refresh = () => cancellation.phase === 'idle' || cancellation.phase === 'confirming'
    ? query.refetch() : cancellation.refresh();
  return (
    <>
      <ConfirmDialog
        open={cancellation.phase === 'confirming' && Boolean(cancellable)}
        title="Cancel this contract?"
        target={nonEmpty(contract?.goal) ?? id}
        description="This asks the daemon to stop the contract and its running units. Files already changed may be incomplete; cancellation does not undo them."
        confirmLabel="Cancel contract"
        cancelLabel="Keep running"
        tone="danger"
        onConfirm={() => { if (cancellable) void cancellation.confirm(); }}
        onCancel={cancellation.dismiss}
      />
      <DetailPane
        title={nonEmpty(contract?.goal) ?? 'Contract'} meta={id} onClose={onClose} closeLabel="Close contract"
        actions={<>
          {cancellable && <Button size="sm" variant="danger" onClick={cancellation.ask} disabled={cancellation.disabled}>
            {cancellation.phase === 'pending' ? 'Cancelling…' : 'Cancel contract'}
          </Button>}
          {onOpenProcess && <Button size="sm" variant="ghost" onClick={onOpenProcess}>Process details</Button>}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}
            disabled={query.isFetching || cancellation.refreshing || cancellation.phase === 'pending'}>Refresh contract</Button>
        </>}
      >
        {cancellation.notice && <p className={`dv-notice${cancellation.phase === 'unknown' ? ' dv-notice--bad' : ''}`}
          role={cancellation.phase === 'unknown' ? 'alert' : 'status'}>{cancellation.notice}</p>}
        {cancellation.needsRefresh && cancellation.phase !== 'unknown' && <p className="dv-notice dv-notice--bad" role="alert">
          Could not refresh the current contract and process state. Refresh before trying again.
        </p>}
        {query.isPending && <SkeletonRows count={4} label="Loading contract" />}
        {query.isError && (
          <p className="dv-notice dv-notice--bad" role="alert">
            {errorCode(query.error) === 'CONTRACT_NOT_FOUND'
              ? 'This contract is no longer available on this daemon.'
              : isMethodUnavailableError(query.error)
                ? 'Contract inspection is unavailable on this daemon.'
                : `Could not load this contract: ${formatError(query.error)}`}
            {' '}<Button size="sm" variant="ghost" onClick={() => void refresh()}>Retry contract</Button>
          </p>
        )}
        {contract && <ContractTree contract={contract} />}
      </DetailPane>
    </>
  );
}
