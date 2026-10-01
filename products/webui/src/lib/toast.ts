import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  createElement,
  type ReactNode,
} from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastEntry extends ToastOptions {
  id: string;
  /** Resolved duration (ms). 0 = persistent. */
  durationMs: number;
  tone: ToastTone;
  /** Internal: remaining ms when paused. */
  remainingMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 5;

/**
 * Exit animation duration in ms. Matches --motion-base (180ms) in tokens.css.
 * Single source of truth, update both when changing the token.
 */
export const TOAST_EXIT_DURATION_MS = 180;

// ─── Reducer ──────────────────────────────────────────────────────────────────

interface ToastState {
  toasts: ToastEntry[];
  /** IDs currently playing their exit animation, still mounted, present=false. */
  leavingIds: ReadonlySet<string>;
}

type ToastAction_Dispatch =
  | { type: 'ADD'; toast: ToastEntry }
  | { type: 'DISMISS'; id: string }
  | { type: 'PURGE'; id: string };

export function toastReducer(state: ToastState, action: ToastAction_Dispatch): ToastState {
  switch (action.type) {
    case 'ADD': {
      const toasts = [...state.toasts, action.toast];
      return {
        ...state,
        toasts: toasts.length > MAX_VISIBLE ? toasts.slice(toasts.length - MAX_VISIBLE) : toasts,
      };
    }
    case 'DISMISS': {
      // Mark as leaving, keep mounted so exit animation can run.
      const next = new Set(state.leavingIds);
      next.add(action.id);
      return { ...state, leavingIds: next };
    }
    case 'PURGE': {
      // Remove from DOM after exit animation completes.
      const next = new Set(state.leavingIds);
      next.delete(action.id);
      return {
        toasts: state.toasts.filter((t) => t.id !== action.id),
        leavingIds: next,
      };
    }
    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface ToastContextValue {
  toasts: ToastEntry[];
  /** IDs that are animating out (present=false, still mounted). */
  leavingIds: ReadonlySet<string>;
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `toast-${Date.now()}-${_idCounter}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [], leavingIds: new Set<string>() });

  const toast = useCallback((options: ToastOptions): string => {
    const id = nextId();
    const entry: ToastEntry = {
      ...options,
      id,
      tone: options.tone ?? 'info',
      // Errors stay until dismissed (design doc "Toast"); everything else leaves after 5 s.
      durationMs: options.durationMs ?? (options.tone === 'danger' ? 0 : DEFAULT_DURATION_MS),
    };
    dispatch({ type: 'ADD', toast: entry });
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    dispatch({ type: 'DISMISS', id });
    // Under reduced motion, skip the exit animation and purge immediately.
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reducedMotion ? 0 : TOAST_EXIT_DURATION_MS;
    setTimeout(() => dispatch({ type: 'PURGE', id }), delay);
  }, []);

  /**
   * Dismiss every visible toast, preserving exit animations.
   * Routes through `dismiss()` so each toast animates out individually.
   */
  const dismissAll = useCallback(() => {
    // Snapshot ids at call time, avoid mutating while iterating.
    const ids = state.toasts.map((t) => t.id);
    ids.forEach((id) => dismiss(id));
  }, [state.toasts, dismiss]);

  return createElement(
    ToastContext.Provider,
    { value: { toasts: state.toasts, leavingIds: state.leavingIds, toast, dismiss, dismissAll } },
    children,
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast(): {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
} {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return { toast: ctx.toast, dismiss: ctx.dismiss, dismissAll: ctx.dismissAll };
}

/**
 * Safe variant, returns null when called outside a ToastProvider.
 * Use in leaf components that may be rendered in test environments without
 * the full provider tree.
 */
export function useOptionalToast(): {
  toast: (options: ToastOptions) => string;
} | null {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return { toast: ctx.toast };
}

/** Internal: exposes full context for ToastViewport. */
export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToastContext must be used within a ToastProvider');
  }
  return ctx;
}

// ─── Auto-dismiss helper (used by Toast component) ────────────────────────────

interface UseAutoDismissOptions {
  id: string;
  durationMs: number;
  onDismiss: (id: string) => void;
}

/**
 * Provides onMouseEnter/onMouseLeave/onFocus/onBlur handlers and starts
 * auto-dismiss timer. Pauses the countdown while the user hovers or while
 * focus is inside the toast (prevents stranding keyboard users mid-action).
 */
export function useAutoDismiss({ id, durationMs, onDismiss }: UseAutoDismissOptions) {
  const remainingRef = useRef(durationMs);
  const startRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Two independent pause channels: hover and focus.
   * Only the FIRST source to activate pauses the timer (decrements remainingMs).
   * The timer only resumes when BOTH sources are inactive.
   *
   * Interleaving example (focus-enter, hover-enter, hover-leave, focus-leave):
   *   1. focus-enter  → focusPausedRef=true,  pauseCount 0→1 → decrement remainingMs, clearTimer
   *   2. hover-enter  → hoverPausedRef=true,  pauseCount 1→2 → already paused, no-op on remainingMs
   *   3. hover-leave  → hoverPausedRef=false, pauseCount 2→1 → still paused (focus active), no start
   *   4. focus-leave  → focusPausedRef=false, pauseCount 1→0 → both clear, call start()
   */
  const hoverPausedRef = useRef(false);
  const focusPausedRef = useRef(false);

  const pauseCount = () => (hoverPausedRef.current ? 1 : 0) + (focusPausedRef.current ? 1 : 0);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = useCallback(() => {
    if (durationMs <= 0 || pauseCount() > 0) return;
    clearTimer();
    startRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      onDismiss(id);
    }, remainingRef.current);
  }, [id, durationMs, onDismiss]);

  useEffect(() => {
    if (durationMs > 0) {
      start();
    }
    return () => clearTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pauseSource = useCallback(
    (source: 'hover' | 'focus') => {
      if (durationMs <= 0) return;
      const wasAlreadyPaused = pauseCount() > 0;
      if (source === 'hover') hoverPausedRef.current = true;
      else focusPausedRef.current = true;
      // Only decrement remainingMs and stop the timer on the first active source.
      if (!wasAlreadyPaused) {
        const elapsed = Date.now() - startRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        clearTimer();
      }
    },
    [durationMs],
  );

  const resumeSource = useCallback(
    (source: 'hover' | 'focus') => {
      if (durationMs <= 0) return;
      if (source === 'hover') hoverPausedRef.current = false;
      else focusPausedRef.current = false;
      // Only re-arm the timer when BOTH sources are inactive.
      if (pauseCount() === 0) {
        start();
      }
    },
    [durationMs, start],
  );

  const handleMouseEnter = useCallback(() => pauseSource('hover'), [pauseSource]);
  const handleMouseLeave = useCallback(() => resumeSource('hover'), [resumeSource]);

  /** Pause timer when focus enters the toast (keyboard users can act on the undo button). */
  const handleFocus = useCallback(() => {
    pauseSource('focus');
  }, [pauseSource]);

  /** Resume timer when focus leaves the toast entirely. */
  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (durationMs <= 0) return;
      // relatedTarget is null when focus leaves the document, or when focus moves
      // outside this toast, resume only in the latter case.
      if (e.currentTarget.contains(e.relatedTarget)) return;
      resumeSource('focus');
    },
    [durationMs, resumeSource],
  );

  return { handleMouseEnter, handleMouseLeave, handleFocus, handleBlur };
}
