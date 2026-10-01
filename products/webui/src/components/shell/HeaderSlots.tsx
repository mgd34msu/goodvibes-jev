/**
 * Header slots: a view can put its own title (and up to one or two icon
 * buttons) into the shell's 48-tall header instead of drawing a second title
 * bar inside itself. The chat uses this for its click-to-rename title and its
 * find button (design doc "App shell": "Title left (click to rename a chat),
 * up to three icon buttons right").
 *
 * ShellLayout owns the slot elements; ShellHeader renders them; a view calls
 * `useHeaderSlots()` and portals into them. While a view has claimed the title
 * slot, the header's plain title text steps aside.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface HeaderSlotsApi {
  /** Element the title portal renders into (null until mounted). */
  titleSlot: HTMLElement | null;
  /** Element the action buttons portal into, before the shell's own buttons. */
  actionsSlot: HTMLElement | null;
  /** Hide the plain header title while a view draws its own; returns the release. */
  claimTitle: () => () => void;
}

interface HeaderSlotsInternal extends HeaderSlotsApi {
  titleClaimed: boolean;
  setTitleSlot: (el: HTMLElement | null) => void;
  setActionsSlot: (el: HTMLElement | null) => void;
}

const HeaderSlotsContext = createContext<HeaderSlotsInternal | null>(null);

export function HeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claimTitle = useCallback(() => {
    setClaims((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setClaims((n) => Math.max(0, n - 1));
    };
  }, []);
  const value = useMemo<HeaderSlotsInternal>(() => ({
    titleSlot,
    actionsSlot,
    claimTitle,
    titleClaimed: claims > 0,
    setTitleSlot,
    setActionsSlot,
  }), [titleSlot, actionsSlot, claimTitle, claims]);
  return <HeaderSlotsContext.Provider value={value}>{children}</HeaderSlotsContext.Provider>;
}

/** For ShellHeader: the ref setters and whether the plain title should hide. */
export function useHeaderSlotHost(): Pick<HeaderSlotsInternal, 'setTitleSlot' | 'setActionsSlot' | 'titleClaimed'> | null {
  const ctx = useContext(HeaderSlotsContext);
  return ctx ? { setTitleSlot: ctx.setTitleSlot, setActionsSlot: ctx.setActionsSlot, titleClaimed: ctx.titleClaimed } : null;
}

/**
 * For views: the slot elements to portal into, with the title slot claimed for
 * as long as the calling component is mounted. Null outside the shell (unit
 * tests that render a view on its own), where a view draws nothing up there.
 */
export function useHeaderSlots(): HeaderSlotsApi | null {
  const ctx = useContext(HeaderSlotsContext);
  const claim = ctx?.claimTitle;
  useEffect(() => (claim ? claim() : undefined), [claim]);
  return ctx ? { titleSlot: ctx.titleSlot, actionsSlot: ctx.actionsSlot, claimTitle: ctx.claimTitle } : null;
}
