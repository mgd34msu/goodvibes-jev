import { useToastContext, TOAST_EXIT_DURATION_MS } from '../../lib/toast';
import { Presence } from '../motion/Presence';
import { Toast } from './Toast';
import '../../styles/components/toast.css';

/**
 * Renders the stacked toast list at the bottom-right of the viewport.
 * Mount this once inside ToastProvider, ideally near the root.
 *
 * Exit animation lifecycle:
 *   1. `dismiss(id)` marks the id as leaving in the reducer (present=false).
 *   2. `<Presence present={false}>` drives the wrapper to `data-state="leaving"`
 *      which triggers the `toast-out` CSS keyframe animation.
 *   3. After `TOAST_EXIT_DURATION_MS` (== --motion-base, 180ms) the reducer
 *      dispatches PURGE, removing the entry from state entirely.
 *
 * Integration:
 * ```tsx
 * // In your shell/App component (owned by Integration workstream):
 * <ToastProvider>
 *   <App />
 *   <ToastViewport />
 * </ToastProvider>
 * ```
 */
export function ToastViewport() {
  const { toasts, leavingIds, dismiss } = useToastContext();

  return (
    <div
      className="toast-viewport"
      aria-label="Notifications"
      role="region"
    >
      {toasts.map((t) => (
        <Presence
          key={t.id}
          present={!leavingIds.has(t.id)}
          exitDurationMs={TOAST_EXIT_DURATION_MS}
        >
          <div className="toast-presence-wrapper">
            <Toast toast={t} onDismiss={dismiss} />
          </div>
        </Presence>
      ))}
    </div>
  );
}
