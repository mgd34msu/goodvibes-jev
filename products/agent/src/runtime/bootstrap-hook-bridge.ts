import type { ConversationManager } from '../core/conversation';
import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import { registerBootstrapHookBridge } from '@/runtime/index.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { emitSessionResumed } from '@/runtime/index.ts';
import { HelperModel } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { SessionSpineClient } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import type { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readConversationMessageSnapshots } from '../core/conversation-message-snapshot.ts';
import { activeTokens } from '../renderer/theme.ts';

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  readonly sessionSpineClient: Pick<SessionSpineClient, 'reopen'>;
  readonly projectRoot: string;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'require' | 'resolveModelPricing'>;
}

export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string) => void {
  return (sessionId: string): void => {
    try {
      const { messages, meta } = options.sessionManager.load(sessionId);
      emitSessionResumed(options.runtimeBus, {
        sessionId: options.runtime.sessionId,
        traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
        source: 'bootstrap',
      }, {
        sessionId,
        turnCount: messages.length,
      });
      options.conversation.fromJSON({
        messages: readConversationMessageSnapshots(messages),
        title: meta.title,
        titleSource: meta.titleSource,
      });
      options.runtime.sessionId = sessionId;
      options.onSessionIdChanged?.(sessionId);
      if (meta?.model) options.runtime.model = meta.model;
      if (meta?.provider) options.runtime.provider = meta.provider;
      options.writeLastSessionPointer(sessionId);
      void options.sharedSessionBroker.reopenSession(sessionId).catch((err) => { logger.debug('session broker reopen session failed', { err }); });
      // Mirror the reopen into the daemon spine, reopen:true is sent ONLY on
      // this explicit user resume verb (fire-and-forget; never blocks the resume).
      options.sessionSpineClient.reopen({ sessionId, project: options.projectRoot });
      options.conversation.log(`Resumed session: ${sessionId}`, { fg: activeTokens().secondary });
      const returnContextMode = getReturnContextMode(options.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          options.conversation.log(`Resume: ${line}`, { fg: activeTokens().textMuted });
        }
        if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
          options.conversation.log('Resume: Remote build-host recovery belongs outside Agent; delegate explicit build/fix/review recovery from Agent.', { fg: activeTokens().textMuted });
        }
        if (returnContextMode === 'assisted') {
          const helperModel = new HelperModel({
            configManager: options.configManager,
            providerRegistry: options.providerRegistry,
          });
          void maybeAssistReturnContextSummary(options.configManager, helperModel, meta.returnContext).then((assisted) => {
            if (!assisted.assistedNarrative) return;
            options.conversation.log(`Resume: ${assisted.assistedNarrative}`, { fg: activeTokens().textMuted });
            options.requestRender();
          });
        }
      }
      options.hookDispatcher.fire({
        path: 'Lifecycle:session:load',
        phase: 'Lifecycle',
        category: 'session',
        specific: 'load',
        sessionId: options.runtime.sessionId,
        timestamp: Date.now(),
        payload: { sessionId },
      }).catch((err: unknown) => logger.debug('Hook route fire error', {
        path: 'Lifecycle:session:load',
        error: summarizeError(err),
      }));
    } catch (error) {
      logger.debug('resumeSession failed', { error: summarizeError(error) });
      options.conversation.log('Failed to resume session.', { fg: activeTokens().error });
    }
    options.requestRender();
  };
}
