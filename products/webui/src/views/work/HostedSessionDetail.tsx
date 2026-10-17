/**
 * Daemon-hosted sessions in the Work view: the attach lifecycle and the detail
 * pane. A hosted session's loop runs inside the daemon, so it does not end
 * when the tab that started it goes away.
 *
 * useHostedAttachment keeps the old Hosted sessions view's rules exactly:
 *   - Selecting a hosted row attaches with a unique attachment id and
 *     renders the returned history, then the live stream (turn and tool frames
 *     filtered to the session).
 *   - Switching rows, leaving the view, closing the tab
 *     detaches passively (fetch keepalive beacon on pagehide), and a
 *     failed passive detach is reported, not swallowed.
 *   - "Leave" confirms first, naming what the session's own detach policy will
 *     do; "End session" kills it for every client, confirmed as a danger.
 *   - The attached record only moves forward to a strictly newer list row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, OctagonX } from 'lucide-react';
import { getClientLifetime, isClientLifetimeCurrent } from '../../lib/client-lifetime';
import { hostedSessionDetachBeacon, sdk } from '../../lib/goodvibes';
import type { HostedSessionHistoryMessage, HostedSessionRecord } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  effectiveDetachPolicyLabel,
  ensureHostedClientId,
  hostedAttachResultFrom,
  hostedAttachedClientCount,
  hostedSessionFromResult,
  hostedStatusLabel,
  hostedTerminationLabel,
} from '../../lib/hosted-sessions';
import {
  hostedLiveMessageFromTurnFrame,
  hostedToolCallFromFrame,
  isTerminalTurnFrame,
  streamDeltaAccumulated,
  type HostedActiveToolCall,
  type HostedLiveMessage,
  type HostedStreamFrame,
} from '../../lib/hosted-session-stream';
import { useHostedSessionRealtime } from '../../hooks/useHostedSessionRealtime';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { DetailPane, DetailSection, Facts, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/StatusDot';
import { SteerComposer } from '../sessions/SteerComposer';
import { sentenceCase } from './work-items';
import { nonEmpty } from '../../lib/non-empty';

export interface HostedAttachment {
  readonly streamError: string | null;
  readonly session: HostedSessionRecord | null;
  readonly history: readonly HostedSessionHistoryMessage[];
  readonly liveMessages: readonly HostedLiveMessage[];
  readonly liveText: string;
  readonly activeToolCalls: readonly HostedActiveToolCall[];
  readonly attaching: boolean;
  readonly attachError: string | null;
  readonly killPending: boolean;
  readonly leave: () => void;
  readonly kill: () => void;
  readonly confirmElement: ReturnType<typeof useConfirm>['element'];
}

/**
 * Attach to `selectedId` (null for none) and keep the attached record current
 * from `listSessions`. `onLeft` runs after an explicit Leave.
 */
export function useHostedAttachment(
  selectedId: string | null,
  listSessions: readonly HostedSessionRecord[],
  onLeft: () => void,
): HostedAttachment {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [attaching, setAttaching] = useState(false);
  const detachRef = useRef<{ sessionId: string; clientId: string } | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const streamRevision = useRef(0);
  const reconcileHistory = useCallback(() => { refreshRef.current?.(); }, []);

  const [attachedSession, setAttachedSession] = useState<HostedSessionRecord | null>(null);
  const [attachHistory, setAttachHistory] = useState<HostedSessionHistoryMessage[]>([]);
  const [liveMessages, setLiveMessages] = useState<HostedLiveMessage[]>([]);
  const [liveText, setLiveText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<HostedActiveToolCall[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const onStreamFrame = useCallback((frame: HostedStreamFrame) => {
    streamRevision.current++;
    const delta = streamDeltaAccumulated(frame);
    if (delta !== null) {
      setLiveText(delta);
      return;
    }
    const liveMessage = hostedLiveMessageFromTurnFrame(frame);
    if (liveMessage) {
      setLiveMessages((current) => [...current, liveMessage]);
      setLiveText('');
    }
    if (isTerminalTurnFrame(frame)) {
      setActiveToolCalls([]);
      refreshRef.current?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
      return;
    }
    const toolCall = hostedToolCallFromFrame(frame);
    if (toolCall) {
      setActiveToolCalls((current) => {
        const rest = current.filter((call) => call.callId !== toolCall.callId);
        return toolCall.state === 'executing' ? [...rest, toolCall] : rest;
      });
    }
  }, [queryClient]);

  const onLifecycleUpdate = useCallback((payload: unknown) => {
    const session = hostedSessionFromResult(payload);
    if (session) setAttachedSession(session);
  }, []);

  const realtime = useHostedSessionRealtime({
    enabled: selectedId !== null,
    attachedSessionId: selectedId,
    onStreamFrame,
    onLifecycleUpdate,
    onReconcile: reconcileHistory,
  });

  // Move the attached record forward only, to a strictly newer row for the same id.
  useEffect(() => {
    if (!attachedSession) return;
    const fresher = listSessions.find((session) => session.id === attachedSession.id);
    if (fresher && fresher.updatedAt > attachedSession.updatedAt) setAttachedSession(fresher);
  }, [listSessions, attachedSession]);

  const killMutation = useMutation({
    mutationFn: (sessionId: string) => sdk.operator.sessions.hosted.kill(sessionId),
    onSuccess: (result) => {
      const updated = hostedSessionFromResult(result);
      if (updated) setAttachedSession(updated);
      toast({ title: 'Session ended', tone: 'info' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
    },
    onError: (error: unknown) => {
      toast({ title: 'Could not end session', description: formatError(error), tone: 'danger' });
    },
  });

  const passiveDetach = useCallback((sessionId: string, detachClientId: string) => {
    void sdk.operator.sessions.hosted.detach(sessionId, detachClientId).catch((error: unknown) => {
      console.warn(`[hosted-sessions] passive detach failed for session ${sessionId}`, error);
      toast({ title: 'Could not detach from a hosted session', description: formatError(error), tone: 'danger' });
    });
  }, [toast]);
  const passiveDetachRef = useRef(passiveDetach);
  useEffect(() => {
    passiveDetachRef.current = passiveDetach;
  }, [passiveDetach]);

  // A hidden page is still attached. Only actual page departure sends a beacon.
  useEffect(() => {
    const beaconDetach = (event: PageTransitionEvent) => {
      if (event.persisted) return; // BFCache restores the same live page.
      const pending = detachRef.current;
      if (pending) hostedSessionDetachBeacon(pending.sessionId, pending.clientId);
    };
    window.addEventListener('pagehide', beaconDetach);
    return () => window.removeEventListener('pagehide', beaconDetach);
  }, []);

  // Every selection owns a distinct attachment, even A -> B -> A. A late
  // success can therefore detach its obsolete owner without touching the new one.
  useEffect(() => {
    setAttachedSession(null);
    setAttachHistory([]);
    setLiveMessages([]);
    setLiveText('');
    setActiveToolCalls([]);
    setAttachError(null);
    setAttaching(Boolean(selectedId));
    if (!selectedId) return;
    const owner = { sessionId: selectedId, clientId: ensureHostedClientId() };
    const lifetime = getClientLifetime();
    let disposed = false;
    let pending = false;
    let refreshAgain = false;
    const current = () => !disposed && isClientLifetimeCurrent(lifetime);
    const refresh = async () => {
      if (!current()) return;
      if (pending) { refreshAgain = true; return; }
      pending = true;
      const revision = streamRevision.current;
      try {
        const result = await sdk.operator.sessions.hosted.attach(owner.sessionId, owner.clientId);
        if (!current()) {
          // Never send a previous owner's cleanup with a replacement credential.
          if (isClientLifetimeCurrent(lifetime)) passiveDetachRef.current(owner.sessionId, owner.clientId);
          return;
        }
        detachRef.current = owner;
        const { session, history } = hostedAttachResultFrom(result);
        if (session?.id !== owner.sessionId) throw new Error('The daemon returned an unexpected hosted session.');
        setAttachError(null);
        setAttachedSession(session);
        if (revision === streamRevision.current) {
          // The authoritative snapshot replaces the full history. If frames
          // arrived during this read, read again before discarding live output.
          setAttachHistory(history);
          setLiveMessages([]);
          if (session.status !== 'running') {
            setLiveText('');
            setActiveToolCalls([]);
          }
        } else refreshAgain = true;
      } catch (error) {
        if (current()) setAttachError(formatError(error));
      } finally {
        pending = false;
        if (current()) {
          setAttaching(false);
          if (refreshAgain) { refreshAgain = false; void refresh(); }
        }
      }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    return () => {
      disposed = true;
      refreshRef.current = null;
      if (detachRef.current === owner) {
        detachRef.current = null;
        if (isClientLifetimeCurrent(lifetime)) passiveDetachRef.current(owner.sessionId, owner.clientId);
      }
    };
  }, [selectedId]);

  async function leave(): Promise<void> {
    if (!attachedSession || !detachRef.current) return;
    const owner = detachRef.current;
    const policy = attachedSession.effectiveDetachPolicy;
    const confirmed = await confirm.ask({
      title: 'Leave this hosted session?',
      target: attachedSession.title || attachedSession.id,
      description: effectiveDetachPolicyLabel(policy),
      confirmLabel: 'Leave',
      tone: policy === 'kill' ? 'danger' : 'default',
    });
    if (!confirmed || detachRef.current !== owner) return;
    try {
      const result = await sdk.operator.sessions.hosted.detach(owner.sessionId, owner.clientId);
      if (detachRef.current !== owner) return;
      const updated = hostedSessionFromResult(result);
      toast({ title: updated?.status === 'terminated' ? 'Session ended' : 'Left the session', tone: 'info' });
    } catch (error) {
      if (detachRef.current !== owner) return;
      toast({ title: 'Detach failed', description: formatError(error), tone: 'danger' });
    }
    detachRef.current = null;
    setAttachedSession(null);
    void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
    onLeft();
  }

  async function kill(): Promise<void> {
    if (!attachedSession) return;
    const confirmed = await confirm.ask({
      title: 'End this hosted session?',
      target: attachedSession.title || attachedSession.id,
      description: 'It ends now for every attached client, whatever its detach policy.',
      confirmLabel: 'End session',
      tone: 'danger',
    });
    if (!confirmed) return;
    killMutation.mutate(attachedSession.id);
  }

  return {
    streamError: realtime.error,
    session: attachedSession,
    history: attachHistory,
    liveMessages,
    liveText,
    activeToolCalls,
    attaching,
    attachError,
    killPending: killMutation.isPending,
    leave: () => void leave(),
    kill: () => void kill(),
    confirmElement: confirm.element,
  };
}

export function HostedSessionDetail({
  attachment,
  fallbackTitle,
  onClose,
}: {
  attachment: HostedAttachment;
  /** The list row's title while attaching. */
  fallbackTitle: string;
  onClose: () => void;
}) {
  const { session } = attachment;
  const closed = session?.status === 'terminated';

  const actions = session ? (
    <>
      {!closed && (
        <Button size="sm" variant="danger" icon={<OctagonX aria-hidden="true" />} onClick={attachment.kill} disabled={attachment.killPending}>
          {attachment.killPending ? 'Ending…' : 'End session'}
        </Button>
      )}
      <Button size="sm" icon={<LogOut aria-hidden="true" />} onClick={attachment.leave}>Leave</Button>
    </>
  ) : undefined;

  return (
    <DetailPane
      title={nonEmpty(session?.title) ?? nonEmpty(session?.id) ?? fallbackTitle}
      status={session ? (
        <span className="work-status">
          <StatusDot tone={closed ? 'idle' : session.status === 'running' ? 'live' : 'ok'} />
          {sentenceCase(hostedStatusLabel(session.status))}
        </span>
      ) : undefined}
      meta={session ? `Hosted · ${session.workspaceRoot}` : 'Hosted session'}
      actions={actions}
      onClose={onClose}
      closeLabel="Close hosted session"
    >
      {attachment.confirmElement}
      {attachment.attaching && <SkeletonRows count={4} label="Attaching" />}
      {!attachment.attaching && (Boolean(attachment.attachError) || !session) && (
        <p className="dv-notice dv-notice--bad" role="alert">
          Could not attach: {attachment.attachError ?? 'Could not attach to this session.'}
        </p>
      )}
      {!attachment.attaching && session && (
        <>
          <p className="work-prose">{effectiveDetachPolicyLabel(session.effectiveDetachPolicy)}</p>
          {closed && <p className="dv-notice" role="status">{hostedTerminationLabel(session) ?? 'terminated'}</p>}
          <Facts
            items={[
              { label: 'Turns', value: String(session.turnCount) },
              { label: 'Messages', value: String(session.messageCount) },
              { label: 'Attached clients', value: String(hostedAttachedClientCount(session)) },
              { label: 'When the last client leaves', value: session.effectiveDetachPolicy === 'kill' ? 'It ends' : 'It keeps running' },
            ]}
          />
          <DetailSection title="Transcript">
            <ol className="work-transcript" aria-label="Transcript">
              {attachment.history.map((message, index) => (
                <li key={`history-${String(index)}`} className="work-transcript__message">
                  <span className="work-transcript__role">{message.role}</span>
                  <span className="work-transcript__body">{message.content}</span>
                </li>
              ))}
              {attachment.liveMessages.map((message, index) => (
                <li key={`live-${String(index)}`} className="work-transcript__message">
                  <span className="work-transcript__role">{message.role}</span>
                  <span className="work-transcript__body">{message.content}</span>
                </li>
              ))}
              {attachment.liveText && (
                <li className="work-transcript__message work-transcript__message--streaming">
                  <span className="work-transcript__role">assistant, writing</span>
                  <span className="work-transcript__body">{attachment.liveText}</span>
                </li>
              )}
            </ol>
            {attachment.history.length === 0 && attachment.liveMessages.length === 0 && !attachment.liveText && (
              <p className="work-prose work-prose--quiet">No messages yet.</p>
            )}
          </DetailSection>
          {attachment.activeToolCalls.length > 0 && (
            <ul className="work-list" aria-label="Running tools">
              {attachment.activeToolCalls.map((call) => <li key={call.callId}>Running: {call.tool}</li>)}
            </ul>
          )}
          <DetailSection title="Continue session">
            <SteerComposer sessionId={session.id} canSteer={!closed} closed={closed} />
          </DetailSection>
        </>
      )}
    </DetailPane>
  );
}
