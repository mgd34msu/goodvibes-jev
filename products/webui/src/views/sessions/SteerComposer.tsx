/**
 * Dispatch receipts use the daemon's input lifecycle, never HTTP success alone.
 * The keyed body retires local text/receipts on session or account/relay changes.
 */

import { useSyncExternalStore, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { SessionContinuation } from './SessionContinuation';
import { getClientLifetime, subscribeClientLifetime, type ClientLifetime } from '../../lib/client-lifetime';
import { useSessionDispatches, type DispatchMode } from '../../hooks/useSessionDispatches';
import { shouldSubmitComposerKey } from '../../lib/composer-keys';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Field';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/steer-composer.css';

interface SteerComposerProps {
  sessionId: string;
  /** True while an agent is bound and the session is open, steer is available. */
  canSteer: boolean;
  /** True when the session is closed, dispatch is disabled with an honest note. */
  closed: boolean;
  /**
   * True when the live session-update stream is currently paused/reconnecting
   * (threaded down from App). A steer still sends over HTTP while
   * the stream is down. Polling still reconciles input receipts; live updates may lag.
   */
  streamPaused?: boolean;
}

export function SteerComposer(props: SteerComposerProps) {
  return <SessionContinuation {...props}><LegacySteerComposer {...props} /></SessionContinuation>;
}

/** Kept separate so legacy receipt tests don't need native admission fixtures. */
export function LegacySteerComposer(props: SteerComposerProps) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  return <ScopedLegacySteerComposer key={`${lifetime.revision}:${props.sessionId}`} {...props} lifetime={lifetime} />;
}

function ScopedLegacySteerComposer({ sessionId, canSteer, closed, streamPaused = false, lifetime }: SteerComposerProps & { lifetime: ClientLifetime }) {
  const [text, setText] = useState('');
  const { dispatches, send, refreshFailed, missingReceipt } = useSessionDispatches(lifetime, sessionId, streamPaused);
  const mode: DispatchMode = canSteer ? 'steer' : 'followUp';

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!body || closed) return;
    if (send(body, mode)) setText('');
  }

  // THE SOFT-KEYBOARD HERO FIX: the steer used to submit ONLY on
  // Cmd/Ctrl+Enter, a key combination no phone soft keyboard can produce, which
  // made the flagship "steer from your phone" action literally impossible. Adopt the
  // companion composer's exact semantics (shouldSubmitComposerKey): plain Enter sends,
  // Shift+Enter inserts a newline, and an in-progress IME composition is never
  // hijacked. A visible >=44px Send button (below) covers the same action for anyone
  // who would rather tap.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitComposerKey(event)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="steer-composer">
      <p className="steer-composer__mode">
        {closed ? (
          <><StatusDot tone="idle" />Session closed: reopen to send</>
        ) : mode === 'steer' ? (
          <><StatusDot tone="ok" />Steer: an agent is working, this reaches it mid-turn</>
        ) : (
          <><StatusDot tone="idle" />Follow-up: no agent is working, this queues a turn</>
        )}
      </p>

      {streamPaused && !closed && (
        <p className="steer-composer__stream-note" role="status">
          Live updates paused: your {mode === 'steer' ? 'steer' : 'follow-up'} will still
          send; delivery updates may take a moment to appear.
        </p>
      )}

      {refreshFailed && (
        <p className="steer-composer__stream-note" role="status">
          Delivery status could not be refreshed. Showing the last confirmed state; checking again automatically.
        </p>
      )}

      {missingReceipt && (
        <p className="steer-composer__stream-note" role="status">
          Some delivery receipts are missing from the latest input list. Showing their last confirmed states.
        </p>
      )}

      <form className="steer-composer__form" onSubmit={submit}>
        <Textarea
          className="steer-composer__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={closed
            ? 'This session is closed.'
            : mode === 'steer'
              ? 'Inject a mid-turn steer…'
              : 'Queue a follow-up turn…'}
          rows={2}
          disabled={closed}
          aria-label={mode === 'steer' ? 'Steer message' : 'Follow-up message'}
          aria-keyshortcuts="Enter"
          onKeyDown={handleKeyDown}
        />
        <div className="steer-composer__row">
          {!closed && (
            <span className="steer-composer__hint">
              <kbd className="gv-kbd">Enter</kbd> to send, <kbd className="gv-kbd">Shift</kbd> <kbd className="gv-kbd">Enter</kbd> for a new line
            </span>
          )}
          <Button
            variant="primary"
            className="steer-composer__send"
            type="submit"
            disabled={closed || !text.trim()}
            aria-label={mode === 'steer' ? 'Send steer' : 'Queue follow-up'}
            icon={<SendHorizontal aria-hidden="true" />}
          >
            {mode === 'steer' ? 'Steer' : 'Queue'}
          </Button>
        </div>
      </form>

      {dispatches.length > 0 && (
        <ul className="steer-composer__dispatches" aria-label="Recent dispatches">
          {dispatches.map((dispatch) => (
            <li key={dispatch.id} className={`steer-dispatch steer-dispatch--${dispatch.state}`}>
              <StatusDot tone={dispatch.state === 'failed' || dispatch.state === 'rejected' ? 'bad'
                : dispatch.state === 'completed' || dispatch.state === 'delivered' ? 'ok'
                  : dispatch.state === 'cancelled' || dispatch.state === 'unknown' ? 'idle' : 'live'} />
              <span className="steer-dispatch__text">{dispatch.text}</span>
              <span className="steer-dispatch__state">
                {dispatch.mode === 'steer' ? 'steer' : 'follow-up'} · {dispatch.state}
              </span>
              {dispatch.error && <span className="steer-dispatch__error">{dispatch.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
