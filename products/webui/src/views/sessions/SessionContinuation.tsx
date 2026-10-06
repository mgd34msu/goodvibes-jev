/** Authoritative session classification shared by conversation and Fleet text actions. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { NativeHostedSessionLookup } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import { inspectNativeSession } from '../../lib/native-session';
import { formatError } from '../../lib/errors';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../../lib/client-lifetime';
import { NativeIntakeForm } from '../work/NativeIntakeForm';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/steer-composer.css';

export interface NativeSessionContinuationBinding {
  sessionId: string;
  projectId: string;
  lifetime: ClientLifetime;
}

interface SessionContinuationProps {
  sessionId: string;
  closed?: boolean;
  streamPaused?: boolean;
  /** Mounted only after the host explicitly classifies this session as legacy. */
  children: ReactNode;
  /** A source-aware surface can share classification without flattening its context into text. */
  renderNative?: (binding: NativeSessionContinuationBinding) => ReactNode;
  renderPending?: (content: ReactNode) => ReactNode;
}

export function SessionContinuation(props: SessionContinuationProps) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  return <ScopedSessionContinuation key={`${lifetime.revision}:${props.sessionId}`} {...props} lifetime={lifetime} />;
}

function ScopedSessionContinuation(props: SessionContinuationProps & { lifetime: ClientLifetime }) {
  const { sessionId, lifetime, closed, streamPaused } = props;
  const [discovery, setDiscovery] = useState<NativeHostedSessionLookup>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => {
      controller.abort();
      if (!disposed && isClientLifetimeCurrent(lifetime)) setError("Session verification timed out.");
    }, 15_000);
    void inspectNativeSession(lifetime, sessionId, controller.signal).then(
      (found) => {
        if (!disposed && isClientLifetimeCurrent(lifetime)) setDiscovery(found);
      },
      (cause: unknown) => {
        if (!disposed && isClientLifetimeCurrent(lifetime))
          setError(controller.signal.aborted ? "Session verification timed out." : formatError(cause));
      }
    ).finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [lifetime, sessionId, attempt]);

  if (discovery?.kind === 'legacy') return props.children;
  if (discovery?.kind === 'native' && props.renderNative)
    return props.renderNative({ sessionId, projectId: discovery.projectId, lifetime });
  if (discovery?.kind === 'native') return (
    <div className="steer-composer">
      <p className="steer-composer__mode"><StatusDot tone={discovery.busy ? 'live' : 'idle'} />
        {discovery.busy
          ? 'Native continuation: the host queues conversation delivery behind any active turn.'
          : 'Native continuation: Submit sends this original through Jev admission.'}
      </p>
      <p className="dv-muted">
        The host captures the completed transcript when the source is submitted. An active reply
        is excluded from that snapshot. This browser sends your original text and session identity;
        it never supplies or rewrites the transcript.
      </p>
      {streamPaused && <p role="status">Live updates are paused. Inspect the saved input to read the host’s current state.</p>}
      <NativeIntakeForm lifetime={lifetime} continuationSessionId={sessionId} projectId={discovery.projectId} closed={closed} />
    </div>
  );
  const pending = (
    <div className="steer-composer">
      {error ? <>
        <p role="alert">Session continuation is unavailable: {error} Nothing was sent. Native sessions require their existing paired owner and native delivery permissions.</p>
        <Button onClick={() => { setError(undefined); setAttempt((value) => value + 1); }}>Retry session verification</Button>
      </> : <p role="status">Verifying session continuation…</p>}
    </div>
  );
  return props.renderPending ? props.renderPending(pending) : pending;
}
