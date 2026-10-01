import { Plug, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import AppShell from './components/shell/AppShell';
import { ShellLayout } from './components/shell/ShellLayout';
import { viewTitle } from './components/shell/nav';
import { PowerChip } from './components/status/PowerChip';
import { WakeChip } from './components/voice/WakeChip';
import { getCommands, registerCommand, unregisterCommand } from './lib/commands';
import { useConfirm } from './components/ui/ConfirmDialog';
import { useUrlState } from './hooks/useUrlState';
import type { ViewId } from './lib/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaemonHealth } from './hooks/useDaemonHealth';
import { usePairingHandoff } from './hooks/usePairingHandoff';
import { useRelayPairingHandoff } from './hooks/useRelayPairingHandoff';
import { usePushSubscriptionReconcile } from './hooks/usePushSubscriptionReconcile';
import { useRealtimeInvalidation } from './hooks/useRealtimeInvalidation';
import { useSessionRealtime } from './hooks/useSessionRealtime';
import { StepUpHost } from './components/auth/StepUpHost';
import { PairingHandoffOffers } from './components/pairing/PairingHandoffOffers';
import { PairingPostureNotice } from './components/pairing/PairingPostureNotice';
import { RelayOverflowBanner } from './components/status/RelayOverflowBanner';
import { WakeBanner } from './components/voice/WakeBanner';
import { useWakeHost } from './lib/voice/useWake';
import { DaemonReceipts } from './components/status/DaemonReceipts';
import { clearStoredAuthToken, getCurrentAuth, hasStoredTokenSync, sdk } from './lib/goodvibes';
import { loadBootSnapshot, queryKeys } from './lib/queries';
import { ChatView } from './views/ChatView';
import { WorkView } from './views/work/WorkView';
import { LibraryView } from './views/library/LibraryView';
import { PersonalView } from './views/personal/PersonalView';
import { PhoneNodeView } from './views/phone/PhoneNodeView';
import { SignedOutGate } from './components/auth/SignedOutGate';
import { DaemonUnreachableGate } from './components/auth/DaemonUnreachableGate';
import { SettingsDialog } from './components/settings/dialog/SettingsDialog';
import type { SettingsSectionId } from './components/settings/dialog/sections';
import { attentionCount } from './lib/fleet';
import { asRecord, bestId, bestTitle, firstString } from './lib/object';
import { nonEmpty } from './lib/non-empty';
import {
  companionSessionsFromListResponse,
  readStoredActiveCompanionSessionId,
  readStoredCompanionSessions,
  writeStoredActiveCompanionSessionId,
  writeStoredCompanionSessions,
} from './lib/companion-chat';
import {
  companionSessionsReducer,
  companionSessionsStateFromStored,
  selectNextSessionId,
  selectVisibleSessions,
} from './lib/companion-sessions-state';
import { formatError, isDaemonUnreachableError, isMethodUnavailableError, isSessionNotFoundError } from './lib/errors';

export default function App() {
  const queryClient = useQueryClient();
  const { view, setView, setTab, tab, session: activeChatSessionId, setSession, setUrlState, settings: settingsSection } = useUrlState();
  const activeView: ViewId = view;
  const [draftChatRequested, setDraftChatRequested] = useState(false);
  // One record of the companion chat sessions this browser knows about (local copies,
  // ids created here and not yet confirmed by the daemon, ids hidden after a delete).
  // See src/lib/companion-sessions-state.ts: the rendered list is derived from it, so
  // no handler can leave two views of the same session disagreeing.
  const [chatSessionsState, dispatchChatSessions] = useReducer(
    companionSessionsReducer,
    undefined,
    () => companionSessionsStateFromStored(readStoredCompanionSessions()),
  );
  // Pairing hand-off: a `#pair=<token>` fragment (from the terminal's `goodvibes pair`
  // QR) is consumed once at mount, the token is stripped from the URL, stored, and
  // validated. `pending` shows the pairing splash instead of the gate; `error` surfaces
  // on the gate. See usePairingHandoff.
  const pairing = usePairingHandoff();
  // Relay pairing hand-off: a `#relay=<gvrelay1.…>` fragment is consumed once at
  // mount, same discipline as the token pairing above, but for a DIFFERENT payload,
  // transport bootstrap, not identity. Storing it is synchronous/local (no daemon
  // round trip), so it never gates first paint the way `pairing.status === 'pending'`
  // does; only a malformed code surfaces, as a banner on the signed-out gate.
  const relayPairing = useRelayPairingHandoff();
  const boot = useQuery({
    queryKey: ['boot'],
    queryFn: loadBootSnapshot,
  });
  const auth = useQuery({
    queryKey: queryKeys.auth,
    queryFn: getCurrentAuth,
    retry: false,
    // Auto-recovery: while the daemon is unreachable, keep re-probing so the shell
    // reveals itself the moment the daemon answers again. A 401 (genuinely signed out)
    // is NOT an unreachable error, so this does not busy-poll the sign-in front door.
    refetchInterval: (query) => (isDaemonUnreachableError(query.state.error) ? 5_000 : false),
  });
  // D-WEBUI-3: auth.current only re-probes once it has ALREADY errored (see
  // refetchInterval above), while healthy it never re-runs on its own, so a daemon
  // death during an idle session would otherwise surface nothing until the user does
  // something that happens to trigger a query. The health poll already re-probes the
  // daemon unconditionally every 15s (useDaemonHealth), so it is the signal that
  // catches an outage while auth.current is sitting on stale "everything is fine" data.
  const health = useDaemonHealth();
  // Wake-word detection, mounted at the shell rather than in a view: it holds a
  // microphone for as long as the user has it on, so its lifetime cannot be a view's
  // lifetime. This resolves voice.wake.* for this surface and applies it; while
  // voice.wake.surfaces.webui is off (the default) it loads no model and calls no
  // getUserMedia, so no permission prompt appears. The transcript sink is registered
  // separately by the view that owns a composer (ChatView).
  useWakeHost();
  // Session liveness: consume the raw un-domained session-update stream, but only once
  // signed in (opening it while signed-out just 401s). It degrades honestly on failure.
  const sessionRealtime = useSessionRealtime(auth.isSuccess);
  // Control-plane invalidation stream: SAME auth gate as the session stream. Opening it
  // unconditionally at mount meant the paste-token sign-in flow (app mounts signed-out)
  // fired it with no token, 401'd, and, because its enable flag never changed, the
  // stream never re-opened after the token was applied, leaving live invalidation dead
  // for the whole session AND painting the raw 401 body across every banner. Gating on
  // auth.isSuccess opens it only once authenticated and re-opens it on every auth
  // transition (sign-in, and a re-auth after a token expiry flips isSuccess back true).
  const realtimeError = useRealtimeInvalidation(auth.isSuccess);
  // Push self-heal: on every rising edge into connected+signed-in (first open, or a
  // reconnect after an outage), compare this browser's live push subscription against
  // the daemon's own record and heal any drift in place. See usePushSubscriptionReconcile.
  usePushSubscriptionReconcile(health.connection === 'connected' && auth.isSuccess);
  // The fleet subscription rides the SAME multiplexed stream as the invalidation
  // hook above; realtimeError == null means that stream is live, so fleet events are
  // flowing and the poll can recede to a safety cadence (FleetView reads this to gate
  // its own poll fallback).
  const fleetSubscriptionActive = realtimeError == null;
  // App-level fleet snapshot: kept warm regardless of the active view so the Fleet
  // nav entry can show an attention badge (count of nodes blocked on a human) even
  // while you are elsewhere. It shares queryKeys.fleet with FleetView, React Query
  // dedupes the fetch and both read the same cache, and it is invalidated by fleet
  // events (useRealtimeInvalidation) for liveness, with the poll as the honest
  // fallback when the subscription is down. Derived purely from current data; no new
  // client store.
  const fleetSnapshot = useQuery({
    queryKey: queryKeys.fleet,
    queryFn: () => sdk.operator.fleet.snapshot(),
    enabled: auth.isSuccess,
    refetchInterval: fleetSubscriptionActive ? 60_000 : 15_000,
  });
  const fleetAttentionCount = useMemo(
    () => attentionCount(fleetSnapshot.data?.nodes ?? []),
    [fleetSnapshot.data],
  );
  const chatSessions = useQuery({
    queryKey: ['companion-chat', 'sessions'],
    queryFn: () => sdk.chat.sessions.list({ limit: 100 }),
    // The sidebar's "Recent" list shows in every view, so the list loads whenever
    // signed in (it used to load only on the chat view).
    enabled: auth.isSuccess,
  });

  const fetchedChatSessions = useMemo(() => {
    return companionSessionsFromListResponse(chatSessions.data);
  }, [chatSessions.data]);
  const chatSessionItems = useMemo(
    () => selectVisibleSessions(chatSessionsState, {
      serverSessions: fetchedChatSessions,
      serverListLoaded: chatSessions.isSuccess,
    }),
    [chatSessions.isSuccess, chatSessionsState, fetchedChatSessions],
  );

  // DELETE-MEANS-DELETE. "Delete" now names a real hard-delete distinct from
  // "close": companion.chat.sessions.delete permanently removes the on-disk
  // record but requires the session to already be closed (409 SESSION_ACTIVE
  // otherwise), so this always closes first, a no-op if the daemon has no separate
  // close route yet (isMethodUnavailableError) or the session is already closed
  // (SESSION_NOT_FOUND from a double-close race). The mutation never trusts the
  // delete call's 200 at face value: it reconciles against a real re-fetch with
  // includeClosed:true and only reports success once the record is genuinely absent,
  // the exact anti-pattern this replaces was trusting the client-side hide (the
  // removed entry in companion-sessions-state) as proof, which just hides a
  // soft-closed record whose file never left disk. A daemon that still only
  // soft-closes (pre-S1) is caught here and surfaces "Delete did not complete"
  // rather than a false "Deleted".
  const deleteChat = useMutation({
    mutationFn: async (sessionId: string) => {
      try {
        await sdk.chat.sessions.close(sessionId);
      } catch (error) {
        if (!isMethodUnavailableError(error) && !isSessionNotFoundError(error)) throw error;
      }
      try {
        await sdk.chat.sessions.delete(sessionId);
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
      }
      const reconciled = await sdk.chat.sessions.list({ includeClosed: true, limit: 100 });
      const stillPresent = companionSessionsFromListResponse(reconciled)
        .some((session) => bestId(session) === sessionId);
      if (stillPresent) {
        throw Object.assign(
          new Error('Delete did not complete, the record still exists'),
          { code: 'DELETE_INCOMPLETE' },
        );
      }
    },
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: ['companion-chat', 'sessions'] });
      const nextSessionId = selectNextSessionId(chatSessionItems, sessionId);
      dispatchChatSessions({ type: 'session-delete-requested', sessionId });
      if (activeChatSessionId === sessionId) {
        setSession(nextSessionId, { replace: true });
        setDraftChatRequested(!nextSessionId);
      }
    },
    onError: (error, sessionId) => {
      // A 404 here means the target is already gone (e.g. a double-delete race),
      // the outcome the user wanted is already true, so leave it hidden. Every OTHER
      // failure, including DELETE_INCOMPLETE from the proof-of-gone reconcile above,
      // restores visibility rather than leaving a false "it's deleted" impression: the
      // optimistic hide was a guess, and this says plainly that the guess was wrong.
      // Restoration comes from the daemon list (onSettled invalidates the query), not
      // from a local copy; before the first successful list the row stays hidden.
      if (isSessionNotFoundError(error)) return;
      dispatchChatSessions({ type: 'session-delete-failed', sessionId });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
    },
  });

  // Both auto-select effects act only on the chat view: the list now loads in every
  // view (for "Recent"), and choosing a session elsewhere would rewrite that view's URL.
  useEffect(() => {
    if (view !== 'chat') return;
    if (!activeChatSessionId && !draftChatRequested && chatSessionItems.length) {
      setSession(bestId(chatSessionItems[0]), { replace: true });
    }
  }, [view, activeChatSessionId, chatSessionItems, draftChatRequested, setSession]);

  useEffect(() => {
    if (view !== 'chat') return;
    if (!chatSessions.isSuccess || !activeChatSessionId) return;
    if (chatSessionItems.some((s) => bestId(s) === activeChatSessionId)) return;
    const nextSessionId = bestId(chatSessionItems[0]);
    setSession(nextSessionId, { replace: true });
    setDraftChatRequested(!nextSessionId);
  }, [view, activeChatSessionId, chatSessionItems, chatSessions.isSuccess, setSession]);

  useEffect(() => {
    writeStoredActiveCompanionSessionId(activeChatSessionId);
  }, [activeChatSessionId]);

  // Seed local session state from localStorage on first mount if URL has no session.
  useEffect(() => {
    if (!activeChatSessionId) {
      const stored = readStoredActiveCompanionSessionId();
      if (stored) setSession(stored, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatSessions.isSuccess || chatSessionItems.length) writeStoredCompanionSessions(chatSessionItems);
  }, [chatSessionItems, chatSessions.isSuccess]);

  useEffect(() => {
    if (!chatSessions.isSuccess) return;
    dispatchChatSessions({ type: 'server-sessions-synced', sessionIds: fetchedChatSessions.map(bestId) });
  }, [chatSessions.isSuccess, fetchedChatSessions]);

  const handleMissingChatSession = useCallback((sessionId: string) => {
    dispatchChatSessions({ type: 'session-reported-missing', sessionId });
    queryClient.removeQueries({ queryKey: ['companion-chat', sessionId] });
    queryClient.removeQueries({ queryKey: ['companion-chat', sessionId, 'messages'] });
    if (activeChatSessionId === sessionId) {
      const nextSessionId = chatSessions.isSuccess ? selectNextSessionId(chatSessionItems, sessionId) : '';
      setSession(nextSessionId, { replace: true });
      setDraftChatRequested(!nextSessionId);
    }
    void queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
  }, [activeChatSessionId, chatSessionItems, chatSessions.isSuccess, queryClient, setSession]);

  const handleNavigate = useCallback(
    (nextView: ViewId, options?: { newChat?: boolean; tab?: string }) => {
      if (options?.newChat) {
        // One URL update for view and session together: setView then setSession would
        // build the second entry from the pre-navigation state and put the old view back.
        setUrlState({ view: nextView, session: '' });
        setDraftChatRequested(true);
        return;
      }
      setView(nextView, options?.tab ? { tab: options.tab } : undefined);
    },
    [setView, setUrlState],
  );

  // The settings dialog lives in the URL (?settings=<section>): opening pushes a
  // history entry, so Back closes it; switching sections replaces the entry.
  const openSettings = useCallback(
    (section?: string) => setUrlState({ settings: nonEmpty(section) ?? 'general' }),
    [setUrlState],
  );
  const closeSettings = useCallback(() => setUrlState({ settings: '' }), [setUrlState]);
  const changeSettingsSection = useCallback(
    (section: SettingsSectionId) => setUrlState({ settings: section }, { replace: true }),
    [setUrlState],
  );
  const openViewFromSettings = useCallback(
    (nextView: ViewId) => setUrlState({ view: nextView, settings: '' }),
    [setUrlState],
  );

  // Open a specific session in the chat view, one history entry (view + session
  // together), used by the CI "open fix session" affordance.
  // The chat list loads in every view (for Recent), so it can predate a session
  // that was just started (a CI fix session): refresh it first, or the chat view
  // would treat the new id as unknown and switch to another chat.
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      void queryClient.refetchQueries({ queryKey: ['companion-chat', 'sessions'] }).finally(() => {
        setDraftChatRequested(false);
        setUrlState({ view: 'chat', session: sessionId });
      });
    },
    [queryClient, setUrlState],
  );

  const recentChats = useMemo(
    () => chatSessionItems.map((session, index) => {
      const id = bestId(session) || String(index);
      return { id, title: bestTitle(session, id) };
    }),
    [chatSessionItems],
  );
  const activeChatTitle = useMemo(
    () => recentChats.find((chat) => chat.id === activeChatSessionId)?.title ?? '',
    [recentChats, activeChatSessionId],
  );
  // The header names the chat you are in, or the destination for every other view.
  const title = activeView === 'chat'
    ? (draftChatRequested || !activeChatTitle ? 'New chat' : activeChatTitle)
    : viewTitle(activeView);
  // The signed-in name as the identity reports it ('' when it reports none).
  const signedInName = useMemo(() => {
    const record = asRecord(auth.data);
    const identity = asRecord(record.identity);
    return firstString(record, ['username', 'name', 'principal']) || firstString(identity, ['name', 'subject']);
  }, [auth.data]);
  const accountName = signedInName || 'Operator';

  const handleNewChat = useCallback(() => handleNavigate('chat', { newChat: true }), [handleNavigate]);
  const handleOpenChat = useCallback((sessionId: string) => {
    setDraftChatRequested(false);
    setUrlState({ view: 'chat', session: sessionId });
  }, [setUrlState]);
  const confirmDialog = useConfirm();
  const askConfirm = confirmDialog.ask;
  const handleDeleteChat = useCallback((sessionId: string, chatTitle: string) => {
    // Truthful confirm text: this is a hard delete, not the close-in-disguise it
    // used to be, see the deleteChat mutation above.
    void askConfirm({
      title: 'Delete this chat?',
      target: chatTitle,
      description: 'The chat is removed for good and cannot be reopened.',
      confirmLabel: 'Delete chat',
      tone: 'danger',
    }).then((confirmed) => {
      if (confirmed) deleteChat.mutate(sessionId);
    });
  }, [askConfirm, deleteChat]);

  // The palette's "Chats" group: the recent chats, each one command that opens it.
  useEffect(() => {
    const ids = recentChats.slice(0, 8).map((chat) => {
      const id = `chats.open.${chat.id}`;
      registerCommand({
        id,
        title: chat.title || 'Untitled chat',
        group: 'chats',
        keywords: ['chat', 'open', 'recent'],
        run: () => handleOpenChat(chat.id),
      });
      return id;
    });
    return () => {
      for (const id of ids) unregisterCommand(id);
    };
  }, [recentChats, handleOpenChat]);
  const handleSearch = useCallback(() => {
    getCommands().find((command) => command.id === 'system.palette')?.run();
  }, []);
  const handleSignOut = useCallback(() => {
    void clearStoredAuthToken().then(() => queryClient.invalidateQueries());
  }, [queryClient]);

  // Honest login gate. Signed-out (auth.current 401 → query error) shows the front door
  // instead of the shell. On first load with a stored token, show a neutral splash while
  // it validates; with NO stored token, show the gate immediately (no white-screen, and
  // no working-looking-but-401ing shell).
  const authPending = auth.isPending;
  const hasToken = hasStoredTokenSync();
  // A genuine 401 (not a network failure) is the ONLY thing that means "signed out",
  // this classification must win over everything else below, including a health-poll
  // outage that happens to be in flight at the same moment: a bad token always routes
  // to sign-in, never the unreachable overlay.
  const authIsUnauthorized = auth.isError && !isDaemonUnreachableError(auth.error);
  // D-WEBUI-3: the daemon is "unreachable" either because auth.current itself just
  // failed with a network error, OR because the independent health poll has declared
  // the connection 'down' (2+ consecutive probe failures), the latter is what catches
  // a daemon that dies mid-session while auth.current was sitting on old success data
  // and had no reason to re-fire. A network failure/health-down state with a stored
  // token means the daemon is unreachable, NOT that the operator is signed out: keep
  // the token and show the honest unreachable state. Recovery is driven by whichever
  // probe flips back first, auth.current's own 5s re-probe once IT has errored, or the
  // health poll's next successful 15s cycle.
  const healthUnreachable = health.connection === 'down';
  const daemonUnreachable = !authIsUnauthorized
    && ((auth.isError && isDaemonUnreachableError(auth.error)) || healthUnreachable)
    && hasToken;
  // D-WEBUI-2: no stored token means signed-out, full stop, this must NOT wait on
  // auth.current's pending/cached state. Gating this on `authPending` let a stale
  // cached success from a previously-cleared token leak through as a flash of the
  // full authenticated shell (401 banners and all) before the query re-settled; a
  // missing token is knowable synchronously, so show the gate immediately.
  const signedOut = !hasToken || authIsUnauthorized;
  const showSplash = hasToken && authPending && !auth.isError;

  // The daemon-unreachable gate promises the operator will "pick up where it left
  // off" once the daemon comes back, that's only true if the workspace underneath
  // stays mounted through the outage. Render it as an overlay ON TOP of the still-
  // mounted (and inert, so it can't be typed into or clicked while hidden) workspace
  // instead of early-returning in its place; a remount would reset the selected
  // session and discard a half-typed steer/follow-up draft.
  // A pairing hand-off in flight shows a neutral splash INSTEAD of the signed-out gate,
  // so scanning a QR never flashes the gate on the way in. Once it resolves, the normal
  // auth flow below takes over (success → shell; failure → gate with pairing.error).
  if (pairing.status === 'pending') {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        <div className="app-splash" role="status" aria-live="polite">
          <img className="app-splash__mark" src="/goodvibes-icon.png" alt="" aria-hidden="true" />
          <span>Pairing this device…</span>
        </div>
      </AppShell>
    );
  }

  if (signedOut) {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        <SignedOutGate
          pairingError={pairing.status === 'error' ? pairing.error : undefined}
          relayPairingError={relayPairing.status === 'error' ? relayPairing.error : undefined}
        />
      </AppShell>
    );
  }

  if (showSplash) {
    return (
      <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
        <div className="app-splash" role="status" aria-live="polite">
          <img className="app-splash__mark" src="/goodvibes-icon.png" alt="" aria-hidden="true" />
          <span>Signing in…</span>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell view={view} onNavigate={handleNavigate} onOpenSettings={openSettings}>
    <div className="app-shell-root">
    <StepUpHost />
    {confirmDialog.element}
    {/* A hand-off bundle (#pair=<token>&offers=…) surfaces its offer set once the
        token has validated. usePairingHandoff clears it back to [] via
        dismissOffers once the operator has decided (submitted or explicitly
        skipped everything), so this never reopens on its own. The daemon's one
        honest plain-http-on-LAN notice line (postureNotice) rides the SAME
        one-shot modal when there IS an offer set. */}
    {pairing.offers.length > 0 && (
      <PairingHandoffOffers
        offers={pairing.offers}
        onDone={() => { pairing.dismissOffers(); pairing.dismissPostureNotice(); }}
        postureNotice={pairing.postureNotice}
      />
    )}
    {/* A plain #pair=<token> hand-off (no offer set) has no modal of its own. The
        posture notice, if any, gets this standalone one-shot banner instead. Never
        re-appears once dismissed (postureNotice only fires once per hand-off). */}
    {pairing.offers.length === 0 && pairing.postureNotice && (
      <PairingPostureNotice notice={pairing.postureNotice} onDismiss={pairing.dismissPostureNotice} />
    )}
    <RelayOverflowBanner />
    {/* voice.wake.indicator: 'banner' is the prominent persistent listening marker.
        Renders nothing for 'statusline' (the header's WakeChip owns that) or 'off'. */}
    <WakeBanner />
    {/* Undelivered daemon receipts, consumed once on connect (see DaemonReceipts). */}
    <DaemonReceipts connected={health.connection === 'connected'} signedIn={auth.isSuccess} />
    {daemonUnreachable && (
      <div className="daemon-gate-overlay">
        <DaemonUnreachableGate
          detail={formatError(auth.error)}
          retrying={auth.isFetching}
          onRetry={() => void auth.refetch()}
        />
      </div>
    )}
    <ShellLayout
      view={activeView}
      title={title}
      activeChatId={activeChatSessionId}
      draftChat={draftChatRequested || !activeChatSessionId}
      recentChats={recentChats}
      deletingChatId={deleteChat.isPending ? (deleteChat.variables ?? null) : null}
      workAttention={fleetAttentionCount}
      accountName={accountName}
      health={health}
      onNavigate={setView}
      onNewChat={handleNewChat}
      onOpenChat={handleOpenChat}
      onDeleteChat={handleDeleteChat}
      onSearch={handleSearch}
      onSignOut={handleSignOut}
      onOpenSettings={openSettings}
      onRefresh={() => void boot.refetch()}
      refreshing={boot.isFetching}
      inert={daemonUnreachable}
      indicators={(
        <>
          {/* These chips replace the status strip's must-stay-visible segments:
              each renders nothing unless its condition holds. */}
          <PowerChip />
          <WakeChip />
          {health.compatibility?.status === 'restart-required' && (
            <div
              className="status-strip__segment status-strip__segment--compatibility-warning"
              role="status"
              aria-label={health.compatibility.message}
              title={health.compatibility.message}
            >
              <TriangleAlert className="status-strip__icon" aria-hidden="true" size={12} />
              <span className="status-strip__label">Reload to update</span>
            </div>
          )}
        </>
      )}
      banners={(
        <>
          {/* Two SSE feeds back this app (the domained invalidation stream and the raw
              session-update stream). A daemon drop trips BOTH, which used to stack two
              near-identical "live updates paused" warnings. Collapse to ONE banner: a
              unified line when both are down, otherwise the specific message. (F7e) */}
          {(realtimeError ?? sessionRealtime.error) && (
            <div className="banner warning">
              <Plug size={16} />
              {' '}
              {realtimeError && sessionRealtime.error
                ? 'Live updates paused: reconnecting. Views fall back to periodic refresh until the stream returns.'
                : (realtimeError ?? sessionRealtime.error)}
            </div>
          )}
          {deleteChat.error && !isSessionNotFoundError(deleteChat.error) && (
            <div className="banner warning"><Plug size={16} /> {formatError(deleteChat.error)}</div>
          )}
        </>
      )}
    >
      {activeView === 'chat' && (
        <ChatView
          activeSessionId={activeChatSessionId}
          sessionItems={chatSessionItems}
          onActiveSessionChange={(sessionId) => {
            setSession(sessionId, { replace: true });
            setDraftChatRequested(false);
          }}
          onDraftSessionRequestedChange={setDraftChatRequested}
          onLocalSessionCreated={(session) => dispatchChatSessions({ type: 'local-session-created', session })}
          onLocalSessionUpdated={(sessionId, session) => dispatchChatSessions({
            type: 'local-session-updated',
            sessionId,
            session,
          })}
          onSessionMissing={handleMissingChatSession}
          userName={signedInName}
        />
      )}
      {activeView === 'work' && (
        <WorkView
          tab={tab}
          onTabChange={setTab}
          subscriptionActive={fleetSubscriptionActive}
          streamPaused={Boolean(sessionRealtime.error)}
          onOpenSession={handleOpenSession}
        />
      )}
      {activeView === 'library' && <LibraryView tab={tab} onTabChange={setTab} />}
      {activeView === 'personal' && <PersonalView tab={tab} onTabChange={setTab} />}
      {activeView === 'phone' && <PhoneNodeView />}
    </ShellLayout>
    <SettingsDialog
      open={Boolean(settingsSection)}
      section={settingsSection ?? ''}
      onSectionChange={changeSettingsSection}
      onClose={closeSettings}
      onOpenView={openViewFromSettings}
      realtimeError={realtimeError}
    />
    </div>
    </AppShell>
  );
}
