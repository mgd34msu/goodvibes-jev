import {
  type ReactNode,
  type ReactElement,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  Children,
} from 'react';
import { useReducedMotion } from './useReducedMotion';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PresenceProps {
  /** Whether the child should be visible. */
  present: boolean;
  /**
   * Duration of the exit animation in ms.
   * Presence unmounts the child after this delay.
   * Ignored when reduced-motion is active (unmounts immediately).
   */
  exitDurationMs?: number;
  children: ReactNode;
}

type Phase = 'unmounted' | 'entering' | 'visible' | 'leaving';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Pure CSS/React mount-unmount transition wrapper.
 *
 * Adds `data-state="entering"|"visible"|"leaving"` to the direct child so
 * CSS can drive the animation:
 *
 * ```css
 * [data-state="entering"] { animation: slideIn var(--motion-base) var(--ease-standard); }
 * [data-state="leaving"]  { animation: slideOut var(--motion-base) var(--ease-standard); }
 * ```
 *
 * No external dependencies.
 */
export function Presence({ present, exitDurationMs = 180, children }: PresenceProps) {
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(present ? 'visible' : 'unmounted');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    clearTimer();

    if (present) {
      if (phase === 'unmounted') {
        // Entering: set entering briefly then switch to visible
        setPhase('entering');
        timerRef.current = setTimeout(() => setPhase('visible'), 16); // one rAF
      } else {
        setPhase('visible');
      }
    } else {
      if (phase === 'unmounted') return;
      if (reducedMotion) {
        setPhase('unmounted');
      } else {
        setPhase('leaving');
        timerRef.current = setTimeout(() => setPhase('unmounted'), exitDurationMs);
      }
    }

    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, reducedMotion]);

  if (phase === 'unmounted') return null;

  const child = Children.only(children);
  if (!isValidElement(child)) return null;

  // Inject data-state onto the child element
  return cloneElement(child as ReactElement<Record<string, unknown>>, {
    'data-state': phase,
  });
}
