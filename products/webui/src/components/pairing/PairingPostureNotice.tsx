/**
 * PairingPostureNotice, the daemon's one honest plain-http-on-LAN line
 * (pairing.posture.get, verbatim wording), shown ONCE right after a plain `#pair=<token>`
 * hand-off with no offer set completes, the hand-off-with-offers case renders the same
 * text inside PairingHandoffOffers itself instead (see App.tsx). Dismissible, and never
 * re-appears for this hand-off once dismissed or acknowledged.
 */
import { Info } from 'lucide-react';
import { Button } from '../ui/Button';

export interface PairingPostureNoticeProps {
  readonly notice: string;
  readonly onDismiss: () => void;
}

export function PairingPostureNotice({ notice, onDismiss }: PairingPostureNoticeProps) {
  return (
    <div className="banner info pairing-posture-notice" role="status" aria-live="polite">
      <Info size={16} aria-hidden="true" />
      <span>{notice}</span>
      <Button size="sm" variant="ghost" className="pairing-posture-notice__dismiss" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
