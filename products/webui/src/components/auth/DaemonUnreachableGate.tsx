/**
 * DaemonUnreachableGate, the honest "can't reach the daemon" state.
 *
 * When auth.current fails with a NETWORK error (the daemon is down or unreachable) and a
 * token is still stored, the app must NOT fall through to the sign-in front door: that
 * wrongly implies the operator is signed out and invites them to re-paste a token that
 * was never the problem. Instead we keep the stored token untouched and show this plain
 * unreachable state. The auth query keeps re-probing while unreachable (App wires a
 * conditional refetchInterval), so the shell reveals itself automatically the moment the
 * daemon answers again, no user action required. A manual "Retry now" is offered for
 * impatience.
 */

import { PlugZap, RefreshCw } from 'lucide-react';
import { Disclosure } from '../data-view/DataView';
import { Button } from '../ui/Button';
import '../../styles/components/auth-gate.css';

export interface DaemonUnreachableGateProps {
  /** Human-readable detail from the failed auth probe, if any. */
  readonly detail?: string;
  /** True while a re-probe is in flight. */
  readonly retrying?: boolean;
  /** Trigger an immediate re-probe (the auth query refetch). */
  readonly onRetry?: () => void;
}

export function DaemonUnreachableGate({ detail, retrying, onRetry }: DaemonUnreachableGateProps) {
  return (
    <div className="signed-out-gate" role="main">
      <div className="signed-out-card">
        <div className="signed-out-mark">
          <PlugZap size={24} aria-hidden="true" />
        </div>
        <h1>Can&rsquo;t reach the daemon</h1>
        <p className="signed-out-lede">
          The operator shell can&rsquo;t reach the GoodVibes daemon right now. Your token is
          still saved. This is a connection problem, not a sign-in problem. The shell will
          reconnect and pick up where it left off as soon as the daemon is back.
        </p>

        <div className="banner warning" role="status" aria-live="polite">
          <RefreshCw size={15} className={retrying ? 'spin' : undefined} aria-hidden="true" />
          {retrying ? ' Reconnecting…' : ' Waiting for the daemon to come back…'}
        </div>

        {detail && <p className="signed-out-note">{detail}</p>}

        <Button onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry now'}
        </Button>

        <Disclosure summary="Why am I seeing this?">
          <ul className="signed-out-help">
            <li>The daemon may have stopped, restarted, or is still booting.</li>
            <li>Check that the daemon process is running and bound to the expected port.</li>
            <li>
              Nothing here signs you out: your stored token is kept and reused
              automatically once the daemon responds.
            </li>
          </ul>
        </Disclosure>
      </div>
    </div>
  );
}
