/**
 * activity-modal.ts, the Activity modal (Ctrl+O, /activity, the Agent
 * workspace's Work area): what the assistant is doing now, what needs you,
 * what is coming up and the recent activity feed.
 *
 * A kit modal on the surface-modal host: the search row is always live (typed
 * text filters every section), ↑↓ and PgUp/PgDn move, Enter on an agent row
 * opens that agent full screen (its transcript and its own composer), Enter on
 * the processes row opens the process monitor. Esc (handled by the host)
 * closes the modal and never stops any work.
 */

import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { activityItems, renderActivityModal, type ActivityModalView, type ActivityView } from '../renderer/activity-modal.ts';
import { isTextBackspace } from '@goodvibes-jev/engine/terminal-shell';

export interface ActivityModalOptions {
  /** The live view, read on every render and key. */
  readonly view: () => ActivityView;
  /** Opens the process monitor (Enter on the processes row, or an agent that cannot open full screen). */
  readonly openProcesses?: () => void;
  /** Opens an agent full screen (shell/session-views.ts); false when it is not known here. */
  readonly openSessionView?: (target: { readonly kind: 'agent'; readonly id: string }) => boolean;
}

export class ActivityModal implements SurfaceModal, ActivityModalView {
  readonly name = 'activity';
  query = '';
  selectedIndex = 0;

  constructor(private readonly options: ActivityModalOptions) {}

  get view(): ActivityView {
    return this.options.view();
  }

  private count(): number {
    return activityItems(this.view, this.query).length;
  }

  private move(delta: number): void {
    const count = this.count();
    if (count === 0) return;
    this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
  }

  private setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      this.setQuery(this.query + token.value);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (isTextBackspace(key)) {
      if (this.query.length > 0) this.setQuery(this.query.slice(0, -1));
    } else if (key === 'enter') {
      const items = activityItems(this.view, this.query);
      const item = items[Math.max(0, Math.min(this.selectedIndex, items.length - 1))];
      if (item?.agentId && this.options.openSessionView?.({ kind: 'agent', id: item.agentId })) {
        host.close(this, 'done');
      } else if (item?.opensProcesses && this.options.openProcesses) {
        host.close(this, 'done');
        this.options.openProcesses();
      }
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderActivityModal(this, screenWidth, screenHeight);
  }
}
