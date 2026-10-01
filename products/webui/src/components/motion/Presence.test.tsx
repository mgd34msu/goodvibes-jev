/**
 * Presence: the mount/unmount transition wrapper. The child gets a data-state
 * of entering → visible while present; when present goes false it stays mounted
 * as "leaving" for exitDurationMs and then unmounts; with reduced motion it
 * unmounts at once.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Presence } from './Presence';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function installMatchMedia(reduced: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    writable: true,
    configurable: true,
  });
}

function render(present: boolean, exitDurationMs = 40): void {
  flushSync(() => {
    root.render(
      <Presence present={present} exitDurationMs={exitDurationMs}>
        <div data-testid="child">hello</div>
      </Presence>,
    );
  });
}

const child = () => container.querySelector('[data-testid="child"]');
const state = () => child()?.getAttribute('data-state') ?? null;

/** Poll until `predicate` holds: the phase changes land in passive effects and timers. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}

beforeEach(() => {
  installMatchMedia(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  installMatchMedia(false);
});

describe('Presence', () => {
  test('present from the start renders the child visible; going absent with no exit time removes it', async () => {
    render(true, 0);
    expect(state()).toBe('visible');
    render(false, 0);
    await waitFor(() => child() === null);
  });

  test('absent from the start renders nothing; becoming present enters and settles visible', async () => {
    render(false);
    expect(child()).toBeNull();
    render(true);
    await waitFor(() => child() !== null);
    expect(['entering', 'visible']).toContain(state() ?? 'absent');
    await waitFor(() => state() === 'visible');
  });

  test('going absent keeps the child mounted as leaving for exitDurationMs, then unmounts', async () => {
    render(true, 80);
    render(false, 80);
    await waitFor(() => state() === 'leaving');
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushSync(() => {});
    expect(state()).toBe('leaving');
    await waitFor(() => child() === null);
  });

  test('with reduced motion the child unmounts at once instead of waiting out the exit', async () => {
    installMatchMedia(true);
    render(true, 500);
    expect(child()).not.toBeNull();
    render(false, 500);
    await waitFor(() => child() === null, 200);
  });
});
