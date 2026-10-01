/**
 * RelayOverflowBanner, the honest "live events were dropped over the relay" notice.
 *
 * When the webui is connected over the relay and the tunnel's send buffer overflows, the
 * daemon emits a `relay-overflow` event carrying the dropped count (never a silent gap). The
 * stream consumers record it into the relay-overflow store; this banner surfaces it so the
 * operator knows the view may be stale, and offers an explicit Resync (refetch every query)
 * that also clears the notice. It renders nothing when no overflow is outstanding.
 */
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useRelayOverflow } from '../../hooks/useRelayOverflow';
import { acknowledgeRelayOverflow } from '../../lib/relay-stream-overflow';
import { Button } from '../ui/Button';
import '../../styles/components/status.css';

export function RelayOverflowBanner() {
  const queryClient = useQueryClient();
  const { totalDropped } = useRelayOverflow();

  if (totalDropped <= 0) return null;

  const handleResync = () => {
    void queryClient.invalidateQueries();
    acknowledgeRelayOverflow();
  };

  return (
    <div className="banner warning relay-overflow-banner" role="status" aria-live="polite">
      <RefreshCw size={16} aria-hidden="true" />
      <span>
        {`Live updates over the relay dropped ${totalDropped} event${totalDropped === 1 ? '' : 's'}, this view may be out of date.`}
      </span>
      <Button size="sm" className="relay-overflow-resync" onClick={handleResync}>
        Resync
      </Button>
    </div>
  );
}
