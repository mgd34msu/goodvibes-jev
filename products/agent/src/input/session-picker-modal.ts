/**
 * SessionPickerModal, state management for the /sessions picker modal.
 *
 * Lists sessions from SessionManager.list(), tracks selected index,
 * and handles load actions.
 */

import type { SessionInfo, SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { ConversationManager } from '../core/conversation';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readConversationMessageSnapshots } from '../core/conversation-message-snapshot.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

function sessionLoadedMessage(name: string, messageCount: number): string {
  return `Loaded session ${name} (${messageCount} messages)`;
}

function sessionDeletionCommandRequiredMessage(name: string): string {
  return `Deletion requires an explicit command: /session delete ${quoteSlashCommandArg(name)} --yes`;
}

export function renderSessionPickerStatePackageText(): string {
  return [
    'Loaded session <session> (<count> messages)',
    'Error',
    'Deletion requires an explicit command: /session delete <session> --yes',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SessionPickerModal
// ---------------------------------------------------------------------------

export class SessionPickerModal {
  public active = false;
  public sessions: SessionInfo[] = [];
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;

  /** Last status message to show in the modal (e.g. error or success). */
  public statusMessage = '';

  /**
   * The always-live search query. Filters the sessions by name and title;
   * selectedIndex and scrollOffset index the filtered list.
   */
  public query = '';

  public constructor(private readonly sessionManager: SessionManager) {}

  /**
   * Open the modal, loading sessions from SessionManager.
   */
  open(): void {
    this.sessions = this.sessionManager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
    this.active = true;
  }

  /** The sessions matching the query (all of them when it is empty). */
  visibleSessions(): SessionInfo[] {
    const q = this.query.trim().toLowerCase();
    if (q.length === 0) return this.sessions;
    return this.sessions.filter((s) => s.name.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q));
  }

  /** Replace the query; the selection returns to the first match. */
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.deleteConfirmationTarget = null;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
  }

  moveUp(): void {
    const count = this.visibleSessions().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + count) % count;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  moveDown(): void {
    const count = this.visibleSessions().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % count;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }

  getSelected(): SessionInfo | null {
    return this.visibleSessions()[this.selectedIndex] ?? null;
  }

  /**
   * Load the currently selected session into the given ConversationManager.
   * Returns true on success, false on error.
   */
  loadSelected(conversationManager: ConversationManager): boolean {
    const session = this.getSelected();
    if (!session) return false;

    try {
      const { meta, messages } = this.sessionManager.load(session.name);
      conversationManager.resetAll();
      conversationManager.fromJSON({ messages: readConversationMessageSnapshots(messages) });
      if (meta.title) conversationManager.title = meta.title;
      conversationManager.rebuildHistory();
      this.statusMessage = sessionLoadedMessage(session.name, messages.length);
      return true;
    } catch (e) {
      this.statusMessage = `Error ${summarizeError(e)}`;
      return false;
    }
  }

  deleteSelected(): boolean {
    const session = this.getSelected();
    if (!session) return false;
    this.deleteConfirmationTarget = null;
    this.statusMessage = sessionDeletionCommandRequiredMessage(session.name);
    return false;
  }

  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.visibleSessions().length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
