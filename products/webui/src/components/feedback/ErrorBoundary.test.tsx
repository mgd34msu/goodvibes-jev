/**
 * Tests for ErrorBoundary component.
 * Uses react-dom/client + flushSync + happy-dom (bunfig.toml preload).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ErrorBoundary from './ErrorBoundary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderInto(
  ui: React.ReactElement,
): { el: HTMLElement; unmount: () => void } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => { root.render(ui); });
  return {
    el,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

function Bomb({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error('Test explosion');
  return <div data-testid="safe">Safe</div>;
}

const origError = console.error;
beforeEach(() => { console.error = () => {}; });
afterEach(() => { console.error = origError; });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  test('renders children when no error is thrown', () => {
    const { el, unmount } = renderInto(
      <ErrorBoundary><Bomb shouldThrow={false} /></ErrorBoundary>,
    );
    expect(el.querySelector('[data-testid="safe"]')?.textContent).toBe('Safe');
    unmount();
  });

  test('catches a throwing child and renders default fallback', () => {
    const { el, unmount } = renderInto(
      <ErrorBoundary><Bomb shouldThrow /></ErrorBoundary>,
    );
    expect(el.textContent).toContain('Test explosion');
    expect(el.querySelector('button')).not.toBeNull();
    unmount();
  });

  test('default fallback uses formatError for the message', () => {
    const richError = Object.assign(new Error('DB down'), {
      category: 'database',
      transport: { status: 503 },
    });
    function ThrowRich(): React.ReactElement { throw richError; }
    const { el, unmount } = renderInto(
      <ErrorBoundary><ThrowRich /></ErrorBoundary>,
    );
    expect(el.textContent).toContain('DB down');
    expect(el.textContent).toContain('503');
    unmount();
  });

  test('renders custom fallback when provided', () => {
    const { el, unmount } = renderInto(
      <ErrorBoundary
        fallback={(err) => (
          <div data-testid="custom">
            custom:{String(err instanceof Error ? err.message : err)}
          </div>
        )}
      >
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(el.querySelector('[data-testid="custom"]')?.textContent).toContain('Test explosion');
    unmount();
  });

  test('reset path: clicking Try again recovers to safe children', () => {
    let throwing = true;
    let doReset!: () => void;

    function Wrapper(): React.ReactElement {
      const [resetKey, setResetKey] = React.useState(0);
      return (
        <ErrorBoundary
          key={resetKey}
          fallback={(_err, resetFn) => {
            doReset = () => {
              throwing = false;
              resetFn();
              setResetKey((n) => n + 1);
            };
            return (
              <button type="button" data-testid="reset-btn" onClick={doReset}>
                Reset
              </button>
            );
          }}
        >
          <Bomb shouldThrow={throwing} />
        </ErrorBoundary>
      );
    }

    const { el, unmount } = renderInto(<Wrapper />);
    expect(el.querySelector('[data-testid="reset-btn"]')).not.toBeNull();

    flushSync(() => { doReset(); });
    expect(el.querySelector('[data-testid="safe"]')?.textContent).toBe('Safe');
    unmount();
  });

  test('onError callback is invoked when an error is caught', () => {
    const onError = mock(() => {});
    const { unmount } = renderInto(
      <ErrorBoundary onError={onError as (e: Error, i: React.ErrorInfo) => void}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(onError.mock.calls.length).toBe(1);
    const firstCall = (onError.mock.calls as unknown as unknown[][])[0];
    expect(firstCall?.[0]).toBeInstanceOf(Error);
    unmount();
  });

  test('default fallback is an alert', () => {
    const { el, unmount } = renderInto(
      <ErrorBoundary><Bomb shouldThrow /></ErrorBoundary>,
    );
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    unmount();
  });
});
