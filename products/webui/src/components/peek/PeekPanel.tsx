/**
 * Peek: the right-side glass drawer for a look-something-up read (the chat's
 * artifacts, and any view that wants a peek without its own list and detail).
 *
 *   PeekProvider  wraps the shell; renders the one peek drawer.
 *   usePeek()     { open, close, isOpen }
 *
 * The drawer is the kit Drawer: 440 wide on desktop, folding the sidebar to its
 * rail while it is open (useRightPanel), and a bottom sheet with a grabber on a
 * phone. Focus moves in on open and returns to the opener on close; Escape
 * closes the peek and nothing underneath it.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Drawer } from '../ui/Drawer';

export interface PeekContent {
  title: string;
  content: ReactNode;
}

interface PeekContextValue {
  open: (payload: PeekContent) => void;
  close: () => void;
  isOpen: boolean;
}

const PeekContext = createContext<PeekContextValue | null>(null);

export function usePeek(): PeekContextValue {
  const ctx = useContext(PeekContext);
  if (!ctx) {
    throw new Error('usePeek must be used within a PeekProvider');
  }
  return ctx;
}

interface PeekPanelProps {
  payload: PeekContent | null;
  isOpen: boolean;
  onClose: () => void;
}

/** The peek drawer itself; PeekProvider renders it. */
export function PeekPanel({ payload, isOpen, onClose }: PeekPanelProps) {
  return (
    <Drawer
      open={isOpen && payload !== null}
      onClose={onClose}
      label={payload?.title ?? 'Details'}
      title={payload?.title}
      className="peek-drawer"
      data-testid="peek-drawer"
    >
      {payload?.content}
    </Drawer>
  );
}

export function PeekProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<PeekContent | null>(null);

  const open = useCallback((next: PeekContent): void => {
    setPayload(next);
  }, []);

  const close = useCallback((): void => {
    setPayload(null);
  }, []);

  const value = useMemo<PeekContextValue>(() => ({ open, close, isOpen: payload !== null }), [open, close, payload]);

  return (
    <PeekContext.Provider value={value}>
      {children}
      <PeekPanel payload={payload} isOpen={payload !== null} onClose={close} />
    </PeekContext.Provider>
  );
}
