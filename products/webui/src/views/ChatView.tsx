import { ChangeEvent, Dispatch, FormEvent, KeyboardEvent, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, CalendarDays, LayoutGrid, Mail } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import { asRecord, bestId, bestTitle, firstString } from '../lib/object';
import { queryKeys } from '../lib/queries';
import { useProviderModelOptions } from '../lib/use-provider-model-options';
import { providerOptionsFromResponse, reasoningOptionsForModel, sortProvidersConfiguredFirst } from '../lib/provider-models';
import { shouldSteerComposerKey, shouldSubmitComposerKey } from '../lib/composer-keys';
import { isSessionNotFoundError, formatError } from '../lib/errors';
import {
  companionSessionFromDetail,
  companionMessagesFromListResponse,
  mergeCompanionMessages,
  LocalCompanionMessage,
} from '../lib/companion-chat';
import { ChatFindButton, ChatTitle, ChatTurnNotice } from './chat/ChatHeader';
import { CHAT_SUGGESTIONS, greeting, greetingName, type SuggestionIcon } from './chat/new-chat';
import { Spark } from '../components/shell/Spark';
import { Button } from '../components/ui/Button';
import { useHeaderSlots } from '../components/shell/HeaderSlots';
import { useHotkeys } from '../hooks/useHotkeys';
import { MessageList } from './chat/MessageList';
import { Composer } from './chat/Composer';
import { ChatSearch } from './chat/ChatSearch';
import { QueuedMessagesPanel } from './chat/QueuedMessagesPanel';
import { useChatSend } from './chat/useChatSend';
import { useWakeTranscriptSink } from '../lib/voice/useWake';
import { useChatStream } from './chat/useChatStream';
import '../styles/components/chat-view.css';
import {
  ACTIVE_TURN_STATES,
  deriveChatTitle,
  messageCreatedAt,
  messageTone,
  messageText,
  IDLE_TURN_PHASE,
  settledTurnLabel,
  workingStatusLabel,
  type TurnPhase,
} from './chat/message-utils';
import { buildLineage } from './chat/lineage';
import { resolveScrollTarget, isScrollTargetReady, findMessageElement } from './chat/search-jump';
import type { ChatViewProps, ChatMessage } from './chat/types';

export type { ChatViewProps };

const SUGGESTION_ICONS: Record<SuggestionIcon, typeof Mail> = {
  calendar: CalendarDays,
  mail: Mail,
  running: LayoutGrid,
  memory: BookOpen,
};

export function ChatView({
  activeSessionId,
  sessionItems,
  onActiveSessionChange,
  onDraftSessionRequestedChange,
  onLocalSessionCreated,
  onLocalSessionUpdated,
  onSessionMissing,
  userName,
}: ChatViewProps) {
  const queryClient = useQueryClient();
  const headerSlots = useHeaderSlots();
  const findRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveTextRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Auto-title bookkeeping: sessions we have already client-side auto-titled (fire once),
  // and sessions the operator renamed by hand (never overwrite a manual title).
  const autoTitledSessionsRef = useRef<Set<string>>(new Set());
  const manuallyTitledSessionsRef = useRef<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [liveText, setLiveText] = useState('');
  // turnState and turnError are ONE value (see TurnPhase in message-utils.ts),
  // not two independently-mutated useState strings: every write, including the
  // reset-on-session-switch effect below, sets both fields in a single setTurn
  // call, so a terminal state (e.g. 'send failed') can never survive a reset
  // that only clears the error text. setTurnState/setTurnError below are thin
  // adapters kept so useChatStream/useChatSend, which only ever touch one field
  // at a time, need no changes.
  const [turn, setTurn] = useState<TurnPhase>(IDLE_TURN_PHASE);
  // The session id a send just created (see the reset-on-switch effect below).
  const sendCreatedSessionRef = useRef('');
  const handleSendSessionSwitch = useCallback((sessionId: string) => {
    sendCreatedSessionRef.current = sessionId;
    onActiveSessionChange(sessionId);
  }, [onActiveSessionChange]);
  const { state: turnState, error: turnError } = turn;
  const setTurnState = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setTurn((current) => ({
      ...current,
      state: (typeof next === 'function' ? (next as (prev: string) => string)(current.state) : next) as TurnPhase['state'],
    }));
  }, []);
  const setTurnError = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setTurn((current) => ({
      ...current,
      error: typeof next === 'function' ? (next as (prev: string) => string)(current.error) : next,
    }));
  }, []);
  const [localMessages, setLocalMessages] = useState<LocalCompanionMessage[]>([]);
  const [pendingUserMessageId, setPendingUserMessageId] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  // Search jump-to-message: set when a MESSAGE-level search result is selected
  // (session-level results carry messageId '' and never set this, see
  // ChatSearch's module doc). Cleared once the target message is found and
  // scrolled to, or the operator navigates to a different session first.
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState('');

  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => sdk.operator.providers.list() });
  const modelCatalog = useQuery({ queryKey: ['models'], queryFn: () => sdk.operator.models.list() });
  const currentModel = useQuery({ queryKey: ['models', 'current'], queryFn: () => sdk.operator.models.current.get() });
  const catalogProviderOptions = useMemo(() => providerOptionsFromResponse(modelCatalog.data), [modelCatalog.data]);

  const providerOptions = useMemo(() => {
    const byId = new Map<string, ReturnType<typeof providerOptionsFromResponse>[number]>();
    for (const provider of providerOptionsFromResponse(providers.data)) byId.set(provider.id, provider);
    for (const provider of catalogProviderOptions) {
      const existing = byId.get(provider.id);
      byId.set(provider.id, existing ? { ...existing, value: { ...asRecord(existing.value), ...asRecord(provider.value) } } : provider);
    }
    return sortProvidersConfiguredFirst([...byId.values()]);
  }, [catalogProviderOptions, providers.data]);
  const currentModelRecord = asRecord(asRecord(currentModel.data).model);
  const currentModelData = Object.keys(currentModelRecord).length ? currentModelRecord : asRecord(currentModel.data);
  const currentRegistryKey = firstString(currentModelData, ['registryKey'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['registryKey'])
    || '';
  const currentProviderId = firstString(currentModelData, ['provider', 'providerId', 'runtimeProviderId'])
    || firstString(asRecord(asRecord(modelCatalog.data).currentModel), ['provider', 'providerId', 'runtimeProviderId'])
    || '';
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId)?.value ?? providerOptions[0]?.value;
  const catalogProviders = useMemo(() => catalogProviderOptions.map(provider => provider.value), [catalogProviderOptions]);
  const providerModels = useProviderModelOptions(selectedProvider, catalogProviders,
    `${activeSessionId}:${providers.dataUpdatedAt}:${modelCatalog.dataUpdatedAt}`,
    providers.isSuccess && modelCatalog.isSuccess && !providers.isFetching && !modelCatalog.isFetching);
  const providerModelOptions = providerModels.models;
  const selectedModelRegistryKey = providerModelOptions.some((model) => model.registryKey === currentRegistryKey) ? currentRegistryKey : '';
  // The effort ladder for the CURRENT model, from its own models.list entry.
  // Null on daemons predating the field, no control renders.
  const effortOptions = useMemo(
    () => reasoningOptionsForModel(catalogProviderOptions.map((provider) => provider.value), currentRegistryKey),
    [catalogProviderOptions, currentRegistryKey],
  );
  const currentEffort = firstString(currentModelData, ['effort'])
    || firstString(asRecord(currentModel.data), ['effort'])
    || '';

  const activeSession = useMemo(
    () => sessionItems.find((session) => bestId(session) === activeSessionId),
    [activeSessionId, sessionItems],
  );
  const activeSessionTitle = activeSessionId ? bestTitle(activeSession, activeSessionId) : 'New chat';

  useEffect(() => {
    if (selectedProviderId) return;
    const preferredProviderId = currentProviderId || providerOptions[0]?.id || '';
    if (preferredProviderId) setSelectedProviderId(preferredProviderId);
  }, [currentProviderId, providerOptions, selectedProviderId]);

  useEffect(
    () => setSessionTitleDraft(activeSessionTitle === activeSessionId ? '' : activeSessionTitle),
    [activeSessionId, activeSessionTitle],
  );

  const renameSession = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) => sdk.chat.sessions.update(sessionId, { title }),
    onSuccess: async (result, variables) => {
      onLocalSessionUpdated(variables.sessionId, companionSessionFromDetail(result) ?? { sessionId: variables.sessionId, title: variables.title });
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', variables.sessionId] });
    },
  });

  const selectModel = useMutation({
    mutationFn: (registryKey: string) => {
      if (!providerModels.hasCurrentModel(registryKey)) throw new Error('Model options changed. Choose a current model.');
      return sdk.operator.models.current.set(registryKey);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'current'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
      ]);
    },
  });

  const selectEffort = useMutation({
    // '' is the "default" option: an explicit null clears the persisted level
    // (omission would silently preserve it).
    mutationFn: (effort: string) =>
      sdk.operator.models.current.set(currentRegistryKey, effort === '' ? null : effort),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['models', 'current'] });
    },
  });

  const invalidateChatState = useCallback(async (sessionId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['companion-chat', sessionId, 'messages'] }),
      queryClient.invalidateQueries({ queryKey: ['companion-chat', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['companion-chat', 'sessions'] }),
    ]);
  }, [queryClient]);

  const messages = useQuery({
    queryKey: ['companion-chat', activeSessionId, 'messages'],
    enabled: Boolean(activeSessionId),
    queryFn: () => sdk.chat.messages.list(activeSessionId),
    retry: (failureCount, error) => !isSessionNotFoundError(error) && failureCount < 2,
    // 'stream paused' is deliberately NOT an ACTIVE_TURN_STATE (isStreaming must go
    // false once the live channel gives up), but it still needs the periodic-refresh
    // fallback, the honest promise a paused stream makes ("live updates are off,
    // falling back to periodic refresh") only holds if something actually keeps
    // polling for a reply that streamed back while nobody was listening.
    refetchInterval: ACTIVE_TURN_STATES.includes(turnState) || turnState === 'syncing' || turnState === 'stream paused' ? 1000 : false,
  });

  // Auth-expiry handoff shared by both chat hooks: re-probe auth.current so a
  // genuinely dead token (401 mid-stream or mid-send) flips the whole app to the
  // signed-out gate (App.tsx unmounts this view when auth.current confirms it),
  // rather than either hook retrying a dead token or collapsing to a dead-end error.
  const onChatAuthExpired = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
  }, [queryClient]);

  useEffect(() => {
    if (!activeSessionId || !messages.isError || !isSessionNotFoundError(messages.error)) return;
    onSessionMissing(activeSessionId);
  }, [activeSessionId, messages.error, messages.isError, onSessionMissing]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = '0px';
    composer.style.height = `${Math.min(Math.max(composer.scrollHeight, 26), 200)}px`;
  }, [draft]);

  useEffect(() => {
    setShowJumpToBottom(false);
  }, [activeSessionId]);

  // Reset the turn lifecycle to idle on every session switch, in ONE setTurn
  // call. Without this, a terminal turnState left over from a prior session's
  // failed/dropped turn (e.g. 'send failed', 'stream paused') rendered in the
  // turn notice until the next send or turn event in the NEWLY active
  // session, even though that session never did anything.
  //
  // The one exempt transition: a first send with no active session creates the
  // session and switches to it mid-send. That switch must NOT wipe the send's
  // own in-flight 'sending'/'submitted' state, or the turn silently reads as
  // idle (no Stop affordance, no streaming bubble) while the daemon is working.
  // useChatSend reports the created id through sendCreatedSessionRef below; the
  // ref is consumed here so any LATER switch to the same session still resets.
  useEffect(() => {
    if (sendCreatedSessionRef.current === activeSessionId && activeSessionId) {
      sendCreatedSessionRef.current = '';
      return;
    }
    setTurn(IDLE_TURN_PHASE);
  }, [activeSessionId]);

  const {
    isStreaming, stop, retryStream, activeToolCalls, toolActivityByMessageId, cancelToolCall: cancelToolCallRaw,
  } = useChatStream({
    activeSessionId,
    liveTextRef,
    onSessionMissing,
    setTurnState,
    setTurnError,
    setLiveText,
    setLocalMessages,
    setPendingUserMessageId,
    invalidateChatState,
    onAuthExpired: onChatAuthExpired,
    turnState,
  });

  // Cancel ONE running tool call, the turn continues (unlike stop(), which ends the
  // whole turn). A refusal or transport failure surfaces through the same turnError
  // banner the rest of the composer already renders.
  const cancelToolCall = useCallback(
    async (callId: string) => {
      try {
        const result = await cancelToolCallRaw(callId);
        if (!result.cancelled) setTurnError('Could not cancel that tool call; it may have already finished.');
      } catch (error) {
        setTurnError(formatError(error));
      }
    },
    [cancelToolCallRaw, setTurnError],
  );

  const send = useChatSend({
    activeSessionId,
    onActiveSessionChange: handleSendSessionSwitch,
    onDraftSessionRequestedChange,
    onLocalSessionCreated,
    onSessionMissing,
    setTurnState,
    setTurnError,
    setLiveText,
    setLocalMessages,
    setPendingUserMessageId,
    invalidateChatState,
    turnState,
    onAuthExpired: onChatAuthExpired,
  });
  const { editAndResend, regenerateFrom: sendRegenerateFrom } = send;

  const messageItems = companionMessagesFromListResponse(messages.data);

  const renderedMessageItems = useMemo(() => {
    const merged = mergeCompanionMessages(messageItems, localMessages, activeSessionId) as ChatMessage[];
    // Fold in tool activity observed live by this browser tab (see useChatStream's
    // toolActivityByMessageId doc comment): attached by message id regardless of
    // whether the message came from local optimistic state or the server-fetched
    // history, both end up with the same id once the turn completes. A message
    // whose id has no entry (older history, or a full page reload) simply renders
    // without a fold, honestly, rather than fabricating one.
    if (toolActivityByMessageId.size === 0) return merged;
    return merged.map((message) => {
      const toolActivity = toolActivityByMessageId.get(bestId(message));
      return toolActivity ? { ...message, toolActivity } : message;
    });
  }, [activeSessionId, localMessages, messageItems, toolActivityByMessageId]);

  // The honest-lineage render model: active messages as nodes, with any superseded
  // (retained) history attached to the node that heads its fork. Derived purely from
  // the server-authoritative list, so it survives reloads and never drops history.
  const lineageNodes = useMemo(() => buildLineage(renderedMessageItems), [renderedMessageItems]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || showJumpToBottom) return;
    window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [activeSessionId, liveText, renderedMessageItems.length, showJumpToBottom]);

  // Search jump-to-message: once the target session is active AND its messages
  // have loaded, locate the message in the DOM and scroll to it. Session switch
  // (onActiveSessionChange) and the messages fetch it triggers are both async,
  // the target message may not exist in lineageNodes/the DOM yet on the render
  // right after selecting a search result, so this effect just no-ops until a
  // later render (driven by lineageNodes changing as messages arrive) finds it.
  // The readiness/lookup rules live in search-jump.ts (framework-free, unit
  // tested there), this effect is just the async-retry wiring around them.
  useEffect(() => {
    if (!isScrollTargetReady(pendingScrollTarget, activeSessionId, lineageNodes) || !pendingScrollTarget) return;
    const target = pendingScrollTarget;
    const element = findMessageElement(scrollRef.current, target.messageId);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightedMessageId(target.messageId);
    setPendingScrollTarget(null);
  }, [pendingScrollTarget, activeSessionId, lineageNodes]);

  // Auto-clear the search jump-to-message highlight after a brief flash. A
  // separate effect (keyed only on highlightedMessageId) so a fresh highlight
  // starting mid-flash restarts its own timer rather than racing the one
  // above's cleanup.
  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = highlightedMessageId;
    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === target ? '' : current));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  useEffect(() => {
    if ((!ACTIVE_TURN_STATES.includes(turnState) && turnState !== 'syncing') || liveText) return;
    const lastMessage = renderedMessageItems.at(-1);
    if (lastMessage && messageTone(lastMessage) === 'assistant') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded by condition; resolves syncing state after DB messages load
      setPendingUserMessageId('');

      setTurnState('completed');
    }
  }, [liveText, renderedMessageItems, turnState]);

  useEffect(() => {
    if (!pendingUserMessageId || turnError) return;
    const pendingUser = renderedMessageItems.find((message) => bestId(message) === pendingUserMessageId);
    const pendingCreatedAt = messageCreatedAt(pendingUser);
    const hasAssistantReply = renderedMessageItems.some((message) => (
      messageTone(message) === 'assistant' && messageCreatedAt(message) >= pendingCreatedAt
    ));
    if (hasAssistantReply) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded by hasAssistantReply; resolves pending turn when message confirmed in DB
      setPendingUserMessageId('');

      setTurnState('completed');
    }
  }, [pendingUserMessageId, renderedMessageItems, turnError]);

  // Client-side auto-title: once a fresh chat has its first user message AND a first
  // assistant reply, replace the crude create-time title (a raw slice of the first
  // message) with a cleaned title derived from that message, via the existing
  // companion.chat.sessions.update verb (there is no server auto-title verb, this is
  // the ruled client-side path). Fires at most once per session and never overwrites a
  // title the operator set by hand.
  useEffect(() => {
    if (!activeSessionId || isRenamingTitle) return;
    if (autoTitledSessionsRef.current.has(activeSessionId)) return;
    if (manuallyTitledSessionsRef.current.has(activeSessionId)) return;
    const firstUser = renderedMessageItems.find((message) => messageTone(message) === 'user');
    const hasAssistantReply = renderedMessageItems.some((message) => messageTone(message) === 'assistant');
    if (!firstUser || !hasAssistantReply) return;
    const firstUserText = messageText(firstUser);
    const derived = deriveChatTitle(firstUserText);
    if (!derived) return;
    const current = activeSessionTitle;
    const looksAutoGenerated = current === ''
      || current === activeSessionId
      || current === 'New Chat'
      || current === 'New chat'
      || current === firstUserText.slice(0, 72)
      || current === derived;
    // Mark handled regardless, so this never re-evaluates for the session.
    autoTitledSessionsRef.current.add(activeSessionId);
    if (!looksAutoGenerated || current === derived) return;
    renameSession.mutate({ sessionId: activeSessionId, title: derived });
  }, [activeSessionId, activeSessionTitle, isRenamingTitle, renderedMessageItems, renameSession]);

  // A confirmed wake's transcript lands in the SAME two places a dictated one does:
  // appended to the draft for review, or sent straight away when
  // voice.wake.autoSubmit says so. The handler is held in a ref and the sink itself is
  // stable, so registering it does not re-register on every keystroke, the wake host
  // outlives this view and must not be churned by it.
  const wakeHandlerRef = useRef<(text: string, autoSubmit: boolean) => void>(() => undefined);
  useEffect(() => {
    wakeHandlerRef.current = (text: string, autoSubmit: boolean) => {
      if (!text) return;
      if (autoSubmit) {
        sendText(text);
        return;
      }
      setDraft(draft.trim() ? `${draft.trimEnd()} ${text}` : text);
      composerRef.current?.focus();
    };
  });
  useWakeTranscriptSink(useCallback((text: string, options: { autoSubmit: boolean }) => {
    wakeHandlerRef.current(text, options.autoSubmit);
  }, []));

  function submitDraft() {
    sendText(draft, attachedFiles);
  }

  /** STEER: send immediately, interrupting the in-flight turn (Ctrl/Cmd+Enter, or hold the send button). */
  function steerDraft() {
    sendText(draft, attachedFiles, { steer: true });
  }

  function sendText(text: string, files: File[] = [], options: { steer?: boolean } = {}) {
    const body = text.trim();
    if (send.isPending || (!body && !files.length)) return;
    const filesToSend = [...files];
    setDraft('');
    setAttachedFiles([]);
    composerRef.current?.focus();
    send.mutate({ body, files: filesToSend, ...(options.steer ? { steer: true } : {}) });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    submitDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSteerComposerKey(event)) {
      event.preventDefault();
      steerDraft();
      return;
    }
    if (!shouldSubmitComposerKey(event)) return;
    event.preventDefault();
    submitDraft();
  }

  async function copyMessage(message: unknown) {
    const id = bestId(message);
    const text = messageText(message);
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    setCopiedMessageId(id);
    window.setTimeout(() => setCopiedMessageId((current) => (current === id ? '' : current)), 1300);
  }

  function resendMessage(message: unknown) {
    const text = messageText(message);
    sendText(text);
  }

  function addAttachedFiles(files: File[]) {
    if (files.length) setAttachedFiles((current) => [...current, ...files]);
  }

  function regenerateFrom(messageId: string) {
    sendRegenerateFrom(messageId, renderedMessageItems);
  }

  function handleMessagesScroll() {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowJumpToBottom(distanceFromBottom > 180);
  }

  function scrollMessagesToBottom() {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    setShowJumpToBottom(false);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    addAttachedFiles(files);
    event.target.value = '';
  }

  function removeAttachedFile(index: number) {
    setAttachedFiles((current) => current.filter((_file, fileIndex) => fileIndex !== index));
  }

  function finishRenamingTitle() {
    if (!isRenamingTitle) return;
    const nextTitle = sessionTitleDraft.trim();
    setIsRenamingTitle(false);
    if (!activeSessionId || !nextTitle || nextTitle === activeSessionTitle) return;
    // A hand-set title is authoritative, never auto-title over it afterwards.
    manuallyTitledSessionsRef.current.add(activeSessionId);
    renameSession.mutate({ sessionId: activeSessionId, title: nextTitle });
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setSessionTitleDraft(activeSessionTitle === activeSessionId ? '' : activeSessionTitle);
      setIsRenamingTitle(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRenamingTitle();
    }
  }

  const slashCommands = [
    { name: 'clear', description: 'Clear the current chat' },
    { name: 'help', description: 'Show available commands' },
    { name: 'new', description: 'Start a new chat session' },
  ] as const;

  // Ctrl F opens the glass find bar (or refocuses its field when it is already
  // open). Scoped to the chat: it only exists while this view is mounted.
  useHotkeys([
    {
      combo: 'mod+f',
      allowInInput: true,
      handler: (event) => {
        event.preventDefault();
        if (showSearch) {
          findRef.current?.querySelector<HTMLInputElement>('input')?.focus();
          return;
        }
        setShowSearch(true);
      },
    },
  ]);

  // A new chat: no session yet and nothing sent. The greeting and the centered
  // composer show only here; the first send turns it into a conversation.
  const isNewChat = !activeSessionId && lineageNodes.length === 0 && !liveText && !isStreaming && !send.isPending;
  const workingLabel = workingStatusLabel(
    turnState,
    activeToolCalls.filter((call) => !call.cancelled).map((call) => call.toolName),
    Boolean(liveText),
  );
  // turnError already renders its exact words above the composer; the notice
  // only adds plain words when there is no error text to show.
  const noticeLabel = turnError ? '' : settledTurnLabel(turnState);
  const name = greetingName(userName);

  function applySuggestion(prompt: string) {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (!composer) return;
      composer.focus();
      composer.setSelectionRange(prompt.length, prompt.length);
    });
  }

  const greetingBlock = isNewChat ? (
    <div className="chat-welcome">
      <h2 className="chat-greeting">
        <Spark size={26} className="chat-greeting__spark" />
        <span>{greeting(new Date().getHours(), name)}</span>
      </h2>
    </div>
  ) : null;

  return (
    <section className="chat-main" data-state={isNewChat ? 'new' : 'conversation'}>
      {headerSlots?.titleSlot && createPortal(
        <ChatTitle
          activeSessionId={activeSessionId}
          title={activeSessionTitle}
          isRenaming={isRenamingTitle}
          draft={sessionTitleDraft}
          onStartRename={() => setIsRenamingTitle(true)}
          onDraftChange={setSessionTitleDraft}
          onFinishRename={finishRenamingTitle}
          onKeyDown={handleTitleKeyDown}
        />,
        headerSlots.titleSlot,
      )}
      {headerSlots?.actionsSlot && createPortal(
        <ChatFindButton open={showSearch} onToggle={() => setShowSearch((v) => !v)} />,
        headerSlots.actionsSlot,
      )}
      {showSearch && (
        <div className="chat-find glass" ref={findRef}>
          <ChatSearch
            sessions={sessionItems}
            onClose={() => setShowSearch(false)}
            onSelect={(payload) => {
              onActiveSessionChange(payload.sessionId);
              setShowSearch(false);
              setPendingScrollTarget(resolveScrollTarget(payload));
            }}
          />
        </div>
      )}
      <MessageList
        nodes={lineageNodes}
        lead={greetingBlock}
        liveText={liveText}
        showJumpToBottom={showJumpToBottom}
        isSendPending={send.isPending}
        isStreaming={isStreaming}
        copiedMessageId={copiedMessageId}
        highlightedMessageId={highlightedMessageId}
        scrollRef={scrollRef}
        onScroll={handleMessagesScroll}
        onJumpToBottom={scrollMessagesToBottom}
        onCopyMessage={(message) => void copyMessage(message)}
        onResendMessage={resendMessage}
        onRegenerateFrom={regenerateFrom}
        onEditMessage={editAndResend}
        onStop={stop}
        activeToolCalls={activeToolCalls}
        onCancelToolCall={(callId) => void cancelToolCall(callId)}
        workingLabel={workingLabel}
      />
      <div className="chat-dock">
        {activeSessionId && <QueuedMessagesPanel sessionId={activeSessionId} active={isStreaming} />}
        <ChatTurnNotice label={noticeLabel} onRetryStream={turnState === 'stream paused' ? retryStream : undefined} />
        <Composer
          layout={isNewChat ? 'centered' : 'docked'}
          placeholder={isNewChat ? 'Ask GoodVibes anything' : 'Reply to GoodVibes'}
          draft={draft}
          attachedFiles={attachedFiles}
          isSendPending={send.isPending}
          onSteer={steerDraft}
          sendError={send.error}
          turnError={turnError}
          renameSessionError={renameSession.error}
          selectModelError={selectModel.error ?? selectEffort.error}
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          providerModelOptions={providerModelOptions}
          selectedModelRegistryKey={selectedModelRegistryKey}
          selectModelPending={selectModel.isPending}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          slashCommands={slashCommands}
          onDraftChange={setDraft}
          onComposerKeyDown={handleComposerKeyDown}
          onSubmit={submit}
          onFileSelection={handleFileSelection}
          onFilesAdded={addAttachedFiles}
          onRemoveAttachedFile={removeAttachedFile}
          onProviderChange={setSelectedProviderId}
          onModelChange={(registryKey) => selectModel.mutate(registryKey)}
          effortLevels={effortOptions?.levels ?? []}
          currentEffort={currentEffort}
          effortPending={selectEffort.isPending}
          onEffortChange={(effort) => selectEffort.mutate(effort)}
        />
        {isNewChat && (
          <div className="chat-suggestions" role="group" aria-label="Start with">
            {CHAT_SUGGESTIONS.map((suggestion) => {
              const Icon = SUGGESTION_ICONS[suggestion.icon];
              return (
                <Button
                  key={suggestion.id}
                  variant="secondary"
                  size="sm"
                  className="chat-suggestion"
                  icon={<Icon size={16} aria-hidden="true" />}
                  onClick={() => applySuggestion(suggestion.prompt)}
                >
                  <span className="chat-suggestion__label">{suggestion.label}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
