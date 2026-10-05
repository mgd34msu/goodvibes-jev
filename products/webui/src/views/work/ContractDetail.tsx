import type { ClientLifetime } from '../../lib/client-lifetime';
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
  // Errors take precedence over a previously cached tree. Failed refreshes must
  // not make stale evidence look like the daemon's current judgment.
  const contract = query.isError ? undefined : query.data;
  return (
    <DetailPane title={nonEmpty(contract?.goal) ?? 'Contract'} meta={id} onClose={onClose} closeLabel="Close contract"
      actions={<>{onOpenProcess && <Button size="sm" variant="ghost" onClick={onOpenProcess}>Process details</Button>}<Button size="sm" variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh contract</Button></>}>
      {query.isPending && <SkeletonRows count={4} label="Loading contract" />}
      {query.isError && (
        <p className="dv-notice dv-notice--bad" role="alert">
          {errorCode(query.error) === 'CONTRACT_NOT_FOUND'
            ? 'This contract is no longer available on this daemon.'
            : isMethodUnavailableError(query.error)
              ? 'Contract inspection is unavailable on this daemon.'
              : `Could not load this contract: ${formatError(query.error)}`}
          {' '}<Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry contract</Button>
        </p>
      )}
      {contract && <ContractTree contract={contract} />}
    </DetailPane>
  );
}
