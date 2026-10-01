/**
 * DaemonReceipts, one-line dismissible notices for the daemon's undelivered
 * receipts, consumed exactly once per connect. The queue carries crash
 * restarts, self-updates, migrations AND pending feature announcements (e.g. a
 * web-surface URL line), all the same { id, text, at } shape, all with the
 * same show-once semantics, so this one surface renders every kind. The daemon
 * pre-renders each line; this surfaces it verbatim (with any URL made
 * clickable) plus a dismiss control, and renders nothing when the queue is empty.
 */
import { Fragment, type ReactNode } from 'react';
import { Bell, X } from 'lucide-react';
import { useDaemonReceipts } from '../../hooks/useDaemonReceipts';
import { IconButton } from '../ui/IconButton';
import '../../styles/components/status.css';

// Split a receipt line into text and http(s) URL runs so an announcement's URL
// (the web-surface link) is clickable. Only fully-formed http/https URLs are
// linkified; everything else renders verbatim.
const URL_SPLIT = /(https?:\/\/[^\s]+)/g;
const URL_HEAD = /^https?:\/\//;

function renderReceiptText(text: string): ReactNode {
  // split with a capturing group keeps the URL runs as their own array entries.
  return text.split(URL_SPLIT).map((part, index) =>
    URL_HEAD.test(part) ? (
      <a key={index} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

export interface DaemonReceiptsProps {
  /** True once the daemon is reachable, the connect edge that consumes receipts. */
  readonly connected: boolean;
  /** True once authenticated, consuming requires an authorized read. */
  readonly signedIn: boolean;
}

export function DaemonReceipts({ connected, signedIn }: DaemonReceiptsProps) {
  const { receipts, dismiss } = useDaemonReceipts(connected, signedIn);

  if (receipts.length === 0) return null;

  return (
    <div className="daemon-receipts" role="status" aria-live="polite">
      {receipts.map((receipt) => (
        <div key={receipt.id} className="banner info daemon-receipt" data-testid="daemon-receipt">
          <Bell size={16} aria-hidden="true" />
          <span className="daemon-receipt__text" title={receipt.text}>{renderReceiptText(receipt.text)}</span>
          <IconButton
            size="sm"
            noTooltip
            className="daemon-receipt__dismiss"
            label={`Dismiss notice: ${receipt.text}`}
            icon={<X size={14} aria-hidden="true" />}
            onClick={() => dismiss(receipt.id)}
          />
        </div>
      ))}
    </div>
  );
}
