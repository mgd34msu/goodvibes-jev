import { X } from 'lucide-react';
import type { ToastEntry, ToastTone } from '../../lib/toast';
import { useAutoDismiss } from '../../lib/toast';

interface ToastProps {
  toast: ToastEntry;
  onDismiss: (id: string) => void;
}

/**
 * Maps tone to the appropriate ARIA role:
 * - `alert`  (assertive) for warning/danger, demands immediate attention.
 * - `status` (polite)    for info/success  , informational only.
 * Per WAI-ARIA, `alert` is implicitly `aria-live="assertive"`; `status` is
 * implicitly `aria-live="polite"`. Do not set `aria-live` redundantly.
 */
export function roleForTone(tone: ToastTone): 'alert' | 'status' {
  return tone === 'warning' || tone === 'danger' ? 'alert' : 'status';
}

/**
 * Individual toast item. Handles auto-dismiss timer, hover-pause,
 * focus-pause (so keyboard users can reach the action button before
 * the toast disappears), action button, and dismiss button.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const { handleMouseEnter, handleMouseLeave, handleFocus, handleBlur } = useAutoDismiss({
    id: toast.id,
    durationMs: toast.durationMs,
    onDismiss,
  });

  return (
    <div
      role={roleForTone(toast.tone)}
      aria-atomic="true"
      data-tone={toast.tone}
      className="toast"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="toast__body" title={toast.description ? `${toast.title} ${toast.description}` : undefined}>
        <p className="toast__title">{toast.title}</p>
        {toast.description && (
          <span className="toast__description">{toast.description}</span>
        )}
      </div>
      <div className="toast__actions">
        {toast.action && (
          <button
            type="button"
            className="toast__action-btn"
            onClick={() => {
              toast.action!.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          className="toast__dismiss-btn"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
