/**
 * SteerComposer, the hero flow. Injects a mid-turn steer (sessions.steer) while an
 * agent is bound, or queues a follow-up turn (sessions.followUp) otherwise.
 *
 * Honesty: the composer is fire-and-optimistic, it reflects the dispatched text
 * locally with an explicit delivery state (queued → delivered, or failed) and never
 * blocks on the POST resolving. The queued/delivered/failed labels mirror the wire's
 * input lifecycle (session-input-queued / -delivered / -completed / -failed); the
 * authoritative state is reconciled on the next sessions.get/messages refetch, which
 * the session-update stream triggers.
 */

import { useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { shouldSubmitComposerKey } from '../../lib/composer-keys';
import { formatError, isSessionClosedError } from '../../lib/errors';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Field';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/steer-composer.css';

export type DispatchMode = 'steer' | 'followUp';
export type DeliveryState = 'queued' | 'delivered' | 'failed';

export interface LocalDispatch {
  id: string;
  mode: DispatchMode;
  text: string;
  state: DeliveryState;
  error?: string;
}

interface SteerComposerProps {
  sessionId: string;
  /** True while an agent is bound and the session is open, steer is available. */
  canSteer: boolean;
  /** True when the session is closed, dispatch is disabled with an honest note. */
  closed: boolean;
  /**
   * True when the live session-update stream is currently paused/reconnecting
   * (threaded down from App). A steer still sends over HTTP while
   * the stream is down, but the delivered/failed confirmation, which is reconciled
   * off the stream-driven refetch, may lag. The composer says so rather than looking
   * silently stuck.
   */
  streamPaused?: boolean;
}

let dispatchSeq = 0;

export function SteerComposer({ sessionId, canSteer, closed, streamPaused = false }: SteerComposerProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [dispatches, setDispatches] = useState<LocalDispatch[]>([]);

  const mode: DispatchMode = canSteer ? 'steer' : 'followUp';

  const setState = (id: string, state: DeliveryState, error?: string) => {
    setDispatches((current) => current.map((d) => (d.id === id ? { ...d, state, error } : d)));
  };

  const mutation = useMutation({
    mutationFn: ({ body }: { id: string; body: string }) => (
      // The daemon steer/follow-up routes read the canonical `body` field only
      // (readSharedSessionMessageBody → body.body, narrowed at SDK 0.30.0); a
      // `{ message }` envelope 400s with "Missing shared session steer body".
      mode === 'steer'
        ? sdk.operator.sessions.steer(sessionId, { body })
        : sdk.operator.sessions.followUp(sessionId, { body })
    ),
    onSuccess: async (_data, variables) => {
      setState(variables.id, 'delivered');
      // Reconcile against the authoritative transcript.
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error, variables) => {
      if (isSessionClosedError(error)) {
        // The chrome (status badge, composer enablement) is driven by the sessions
        // query, not by this local dispatch state, without this invalidation the
        // session keeps reading as "active" and the user can keep firing 409s.
        setState(variables.id, 'failed', 'This session is closed. Reopen it to continue.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        return;
      }
      setState(variables.id, 'failed', formatError(error));
    },
  });

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!body || closed) return;
    const id = `dispatch-${++dispatchSeq}`;
    const entry: LocalDispatch = { id, mode, text: body, state: 'queued' };
    setDispatches((current) => [entry, ...current].slice(0, 20));
    setText('');
    mutation.mutate({ id, body });
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
          send; the delivered/failed result may take a moment to appear.
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
              <StatusDot tone={dispatch.state === 'failed' ? 'bad' : dispatch.state === 'delivered' ? 'ok' : 'live'} />
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
