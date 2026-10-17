import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { saveWorkTreeFolds } from './work-tree-fold-store.ts';
import { restoreWorkTreeFolds } from './work-tree-wiring.ts';
import type { SessionMeta } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { ConversationManager } from './conversation.ts';
import { readConversationMessageSnapshots } from './conversation-message-snapshot.ts';

/** Restore both resume entry points from the same clean conversation boundary. */
export function restoreLoadedSession(
  sessionId: string,
  loaded: { messages: readonly object[]; meta: SessionMeta },
  deps: {
    conversation: ConversationManager;
    surface?: SessionSurface | undefined;
    runtime: { sessionId: string; model: string; provider: string };
    restoreTurnAnchors?: ((sessionId: string) => number) | undefined;
  },
): number {
  deps.conversation.resetAll();
  deps.conversation.fromJSON({ messages: readConversationMessageSnapshots(loaded.messages), title: loaded.meta.title, titleSource: loaded.meta.titleSource });
  if (deps.surface) restoreWorkTreeFolds(deps.conversation, deps.surface.sessionsDir, sessionId);
  deps.conversation.rebuildHistory();
  deps.runtime.sessionId = sessionId;
  if (loaded.meta.model) deps.runtime.model = loaded.meta.model;
  if (loaded.meta.provider) deps.runtime.provider = loaded.meta.provider;
  return deps.restoreTurnAnchors?.(sessionId) ?? 0;
}


export function copySessionSidecars(source: string, destination: string, conversation: ConversationManager, surface?: SessionSurface): void {
  if (source === destination) return;
  clearTurnAnchors(destination);
  for (const anchor of getTurnAnchors(source)) recordTurnAnchor(destination, anchor);
  if (!surface) return;
  if (getTurnAnchors(destination).length === 0) rmSync(join(surface.sessionsDir, `${destination}.anchors.json`), { force: true });
  else persistTurnAnchors(destination, surface);
  saveWorkTreeFolds(surface.sessionsDir, destination, conversation.workTree.foldState(), conversation.workTree.turnOutcomes());
}
