/**
 * Shared overlay mechanics for the component kit: focus management, outside
 * dismissal, floating placement and media queries. Every floating or modal kit
 * component (Menu, Select, Tooltip, Dialog, Sheet, Drawer) builds on these.
 *
 * Escape handling rule: an overlay handles Escape on its own element and stops
 * propagation, so the key never reaches anything underneath (a parent dialog, a
 * view's own Escape binding). Escape closes the overlay and nothing else.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[inert]') && !el.closest('[aria-hidden="true"]') && !el.hidden,
  );
}

/**
 * Trap Tab inside `containerRef` while `active`, move focus in on open (the
 * `initialFocusRef` element, else the first focusable, else the container), and
 * return focus to whatever held it before the overlay opened.
 */
export function useModalFocus(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
  options?: { recoverFocus?: boolean },
): void {
  // A non-modal overlay (the desktop peek drawer) wraps Tab inside itself but
  // lets a pointer move focus to the page beside it.
  const recoverFocus = options?.recoverFocus ?? true;
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target = initialFocusRef?.current ?? getFocusable(container)[0] ?? container;
    target.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !container) return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onFocusIn(event: FocusEvent): void {
      if (!container || container.contains(event.target as Node | null)) return;
      // A nested floating layer (a Select popover or Tooltip inside this dialog)
      // renders in its own portal; focus there is still "inside" this overlay.
      const targetEl = event.target instanceof HTMLElement ? event.target : null;
      if (targetEl?.closest('[data-gv-layer]')) return;
      (getFocusable(container)[0] ?? container).focus({ preventScroll: true });
    }

    container.addEventListener('keydown', onKeyDown);
    if (recoverFocus) document.addEventListener('focusin', onFocusIn, true);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (recoverFocus) document.removeEventListener('focusin', onFocusIn, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // initialFocusRef is a ref object; its identity is stable.
  }, [active, containerRef, initialFocusRef, recoverFocus]);
}

/**
 * The open-overlay stack, in open order. Escape closes only the overlay on top:
 * an overlay that listens for Escape outside its own element (the non-modal peek
 * drawer, the command palette) asks `isTopOverlay` before it acts.
 */
const overlayStack: symbol[] = [];

/** Register an open overlay; returns a function that reports whether it is on top. */
export function useOverlayLayer(active: boolean): () => boolean {
  const tokenRef = useRef<symbol | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    const token = Symbol('gv-overlay');
    tokenRef.current = token;
    overlayStack.push(token);
    return () => {
      const index = overlayStack.lastIndexOf(token);
      if (index >= 0) overlayStack.splice(index, 1);
      tokenRef.current = null;
    };
  }, [active]);
  return useCallback(() => {
    const token = tokenRef.current;
    return token !== null && overlayStack[overlayStack.length - 1] === token;
  }, []);
}

/**
 * Escape that lands outside every overlay (focus fell back to the page, say after
 * the button that held it was disabled) closes the overlay on top, and only that
 * one. Escape inside an overlay is that overlay's own business (its onKeyDown);
 * a key something else already used (defaultPrevented) is left alone.
 */
export function useTopLayerEscape(
  open: boolean,
  isTop: () => boolean,
  onClose: () => void,
): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTop()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-gv-layer]')) return;
      event.preventDefault();
      closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isTop]);
}

/** Test seam: how many overlays are registered. */
export function openOverlayCount(): number {
  return overlayStack.length;
}

/** Call `onDismiss` on a pointer press outside every element in `refs` while `active`. */
export function useOutsidePress(
  active: boolean,
  refs: readonly RefObject<HTMLElement | null>[],
  onDismiss: () => void,
): void {
  const handlerRef = useRef(onDismiss);
  useLayoutEffect(() => {
    handlerRef.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return undefined;
    function onPointerDown(event: PointerEvent | MouseEvent): void {
      const target = event.target as Node | null;
      if (!target) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      handlerRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
    // refs is an array of stable ref objects supplied by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

export type Placement =
  | 'bottom-start'
  | 'bottom-end'
  | 'bottom'
  | 'top-start'
  | 'top-end'
  | 'top'
  | 'right'
  | 'right-start'
  | 'left';

export interface FloatingPosition {
  top: number;
  left: number;
  placement: Placement;
}

const VIEWPORT_MARGIN = 8;

/** Pure placement math, exported for unit tests. Flips vertically when it would overflow. */
export function computeFloatingPosition(
  anchor: { top: number; left: number; right: number; bottom: number; width: number; height: number },
  floating: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  gap = 6,
): FloatingPosition {
  let resolved = placement;
  const fitsBelow = anchor.bottom + gap + floating.height <= viewport.height - VIEWPORT_MARGIN;
  const fitsAbove = anchor.top - gap - floating.height >= VIEWPORT_MARGIN;
  if (resolved.startsWith('bottom') && !fitsBelow && fitsAbove) resolved = resolved.replace('bottom', 'top') as Placement;
  else if (resolved.startsWith('top') && !fitsAbove && fitsBelow) resolved = resolved.replace('top', 'bottom') as Placement;
  if (resolved === 'right' || resolved === 'right-start') {
    if (anchor.right + gap + floating.width > viewport.width - VIEWPORT_MARGIN) resolved = 'left';
  }

  let top = 0;
  let left = 0;
  switch (resolved) {
    case 'bottom-start': top = anchor.bottom + gap; left = anchor.left; break;
    case 'bottom-end': top = anchor.bottom + gap; left = anchor.right - floating.width; break;
    case 'bottom': top = anchor.bottom + gap; left = anchor.left + anchor.width / 2 - floating.width / 2; break;
    case 'top-start': top = anchor.top - gap - floating.height; left = anchor.left; break;
    case 'top-end': top = anchor.top - gap - floating.height; left = anchor.right - floating.width; break;
    case 'top': top = anchor.top - gap - floating.height; left = anchor.left + anchor.width / 2 - floating.width / 2; break;
    case 'right': top = anchor.top + anchor.height / 2 - floating.height / 2; left = anchor.right + gap; break;
    case 'right-start': top = anchor.top; left = anchor.right + gap; break;
    case 'left': top = anchor.top + anchor.height / 2 - floating.height / 2; left = anchor.left - gap - floating.width; break;
  }
  const maxLeft = viewport.width - VIEWPORT_MARGIN - floating.width;
  const maxTop = viewport.height - VIEWPORT_MARGIN - floating.height;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop));
  return { top: Math.round(top), left: Math.round(left), placement: resolved };
}

/**
 * Keep `floatingRef` placed against `anchorRef` while `open`: measured before
 * paint, re-measured on resize and on any scroll (capture phase, so scrolling a
 * nested pane moves the popover with its anchor).
 */
export function useFloatingPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  placement: Placement,
  options?: { matchWidth?: boolean; gap?: number },
): FloatingPosition | null {
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const matchWidth = options?.matchWidth ?? false;
  const gap = options?.gap ?? 6;

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;
    if (matchWidth) floating.style.minWidth = `${anchor.getBoundingClientRect().width}px`;
    const a = anchor.getBoundingClientRect();
    const f = floating.getBoundingClientRect();
    setPosition(
      computeFloatingPosition(
        a,
        { width: f.width, height: f.height },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
        gap,
      ),
    );
  }, [anchorRef, floatingRef, placement, matchWidth, gap]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  return position;
}

/** Live `matchMedia` result. False where matchMedia is unavailable (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The phone breakpoint from the design doc: under 900 the shell is a drawer layout. */
export const PHONE_QUERY = '(max-width: 899px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

let idCounter = 0;
/** Stable DOM id for aria wiring when React's useId is not wanted in a string template. */
export function nextDomId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
