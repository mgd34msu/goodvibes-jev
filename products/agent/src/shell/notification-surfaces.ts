/**
 * notification-surfaces.ts, where the main conversation's system notices are
 * seen.
 *
 * The transcript draws no row for a system notice (core/notices.ts): each one
 * is a toast in the top right (renderer/toast-center.ts, drawn by
 * buildConversationLayers) and an entry, full text, in the notification
 * history, which /notifications opens as a kit modal.
 */

import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import { NotificationsModal } from '../input/notifications-modal.ts';
import { getSharedNotificationFeed } from '../core/notifications-feed.ts';
import { bridgeNotificationFeedToToasts, getSharedToastCenter } from '../renderer/toast-center.ts';

export interface NotificationSurfaceOptions {
  readonly commandContext: CommandContext;
  readonly input: InputHandler;
  readonly render: () => void;
}

export function wireNotificationSurfaces(options: NotificationSurfaceOptions): void {
  const { commandContext, input, render } = options;
  const toasts = getSharedToastCenter();
  toasts.onChange = render;
  bridgeNotificationFeedToToasts(getSharedNotificationFeed(), toasts);

  commandContext.openNotifications = () => {
    const open = input.surfaceModals.modals().find((modal) => modal instanceof NotificationsModal);
    input.surfaceModals.push(open ?? new NotificationsModal({
      feed: getSharedNotificationFeed(),
      // Agent and chain notices are about what the Activity modal shows.
      resolveSubject: (subject) => (subject === 'agents' && commandContext.openActivityModal
        ? () => { commandContext.openActivityModal?.(); }
        : null),
    }));
    render();
  };
}
