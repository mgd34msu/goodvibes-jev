/**
 * DOM tests for useAutoDismiss (src/lib/toast.ts).
 * Exercises the REAL hook via react-dom/client + happy-dom (bunfig.toml preload).
 *
 * Uses real timers with short durations (50 ms baseline) so tests run fast
 * without fake-timer / Date.now coordination complexity. This matches the
 * timer approach in src/hooks/useAnnouncer.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useAutoDismiss } from './toast';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AutoDismissHandlers = ReturnType<typeof useAutoDismiss>;

/**
 * Component that mounts useAutoDismiss and surfaces the handlers via a ref
 * callback so tests can trigger mouseenter/mouseleave/focus/blur events.
 */
function HookOwner({
  id,
  durationMs,
  onDismiss,
  onHandlers,
}: {
  id: string;
  durationMs: number;
  onDismiss: (id: string) => void;
  onHandlers: (h: AutoDismissHandlers) => void;
}): null {
  const handlers = useAutoDismiss({ id, durationMs, onDismiss });
  React.useLayoutEffect(() => {
    onHandlers(handlers);
  });
  return null;
}

function renderHook({
  id = 'toast-1',
  durationMs,
  onDismiss,
}: {
  id?: string;
  durationMs: number;
  onDismiss: (id: string) => void;
}) {
  let handlers!: AutoDismissHandlers;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <HookOwner
        id={id}
        durationMs={durationMs}
        onDismiss={onDismiss}
        onHandlers={(h) => {
          handlers = h;
        }}
      />,
    );
  });
  return {
    get handlers() {
      return handlers;
    },
    unmount: () => {
      flushSync(() => {
        root.unmount();
      });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/** Move the fake clock (timers and Date.now) forward by exactly `ms`. */
const elapse = (ms: number): void => {
  jest.advanceTimersByTime(ms);
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let containers: HTMLElement[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  containers = [];
});

afterEach(() => {
  containers.forEach((el) => {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAutoDismiss (real hook, DOM render)', () => {
  test('auto-dismisses after durationMs with no interaction', () => {
    const onDismiss = mock((_id: string) => {});
    const { unmount } = renderHook({ durationMs: 60, onDismiss });

    // Should not have fired yet
    expect(onDismiss).not.toHaveBeenCalled();

    // Wait longer than durationMs
    elapse(100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('toast-1');

    unmount();
  });

  test('persistent toast (durationMs=0) never auto-dismisses', () => {
    const onDismiss = mock((_id: string) => {});
    const { unmount } = renderHook({ durationMs: 0, onDismiss });

    elapse(80);
    expect(onDismiss).not.toHaveBeenCalled();

    unmount();
  });

  test('hover pause stops timer; hover leave resumes: fires after remaining time', () => {
    const onDismiss = mock((_id: string) => {});
    const { handlers, unmount } = renderHook({ durationMs: 200, onDismiss });

    // Let 60ms elapse, then pause on hover
    elapse(60);
    handlers.handleMouseEnter();

    // Wait well past original 200ms deadline, timer should stay paused
    elapse(180);
    expect(onDismiss).not.toHaveBeenCalled();

    // Resume hover: exactly the remaining 140ms is left on the timer
    handlers.handleMouseLeave();
    elapse(139);
    expect(onDismiss).not.toHaveBeenCalled();
    elapse(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('focus pause stops timer; focus-blur resumes: fires after remaining time', () => {
    const onDismiss = mock((_id: string) => {});
    const { handlers, unmount } = renderHook({ durationMs: 200, onDismiss });

    elapse(60);
    handlers.handleFocus();

    elapse(180);
    expect(onDismiss).not.toHaveBeenCalled();

    // Simulate blur where focus moves outside the toast (relatedTarget = null → outside)
    const fakeBlur = {
      currentTarget: { contains: (_n: Node | null) => false },
      relatedTarget: null,
    } as unknown as React.FocusEvent;
    handlers.handleBlur(fakeBlur);

    elapse(200);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    unmount();
  });

  test(
    'focus-enter → hover-enter → hover-leave stays paused → focus-leave resumes (exactly-once decrement)',
    () => {
      const onDismiss = mock((_id: string) => {});
      const { handlers, unmount } = renderHook({ durationMs: 300, onDismiss });

      // 1. focus-enter: timer paused, remaining decremented from full duration
      elapse(50);
      handlers.handleFocus();

      // 2. hover-enter while focus already active: already paused → no second decrement
      elapse(30);
      handlers.handleMouseEnter();

      // 3. hover-leave: focus still active → timer must NOT resume
      elapse(20);
      handlers.handleMouseLeave();

      // Wait past original 300ms, must stay paused
      elapse(300);
      expect(onDismiss).not.toHaveBeenCalled();

      // 4. focus-leave: both channels clear → timer re-arms for remaining time
      const fakeBlur = {
        currentTarget: { contains: (_n: Node | null) => false },
        relatedTarget: null,
      } as unknown as React.FocusEvent;
      handlers.handleBlur(fakeBlur);

      // Now the timer should fire (remaining was ~250ms from the 50ms elapsed before pause)
      elapse(350);
      expect(onDismiss).toHaveBeenCalledTimes(1);

      unmount();
    },
  );

  test('blur that stays inside currentTarget does not resume timer', () => {
    const onDismiss = mock((_id: string) => {});
    const { handlers, unmount } = renderHook({ durationMs: 200, onDismiss });

    elapse(40);
    handlers.handleFocus();

    // Blur where focus stays inside the element, should NOT resume
    const innerNode = document.createElement('button');
    const fakeBlur = {
      currentTarget: { contains: (_n: Node | null) => true },
      relatedTarget: innerNode,
    } as unknown as React.FocusEvent;
    handlers.handleBlur(fakeBlur);

    elapse(220);
    expect(onDismiss).not.toHaveBeenCalled();

    unmount();
  });

  test('unmounting before timeout does not call onDismiss', () => {
    const onDismiss = mock((_id: string) => {});
    const { unmount } = renderHook({ durationMs: 100, onDismiss });

    elapse(20);
    unmount();

    elapse(120);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
