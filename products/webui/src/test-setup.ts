/**
 * Test environment setup for bun:test.
 *
 * Uses @happy-dom/global-registrator to install a full happy-dom Window as
 * the persistent global environment for the entire test process. This gives
 * React-DOM a real window/document/event system so its scheduler never hits
 * "window is not defined", even when async callbacks fire between tests.
 *
 * We register ONCE and never unregister, so any stray scheduler tick that
 * fires after a test's own unmount still finds a valid window binding.
 *
 * Loaded via bunfig.toml [test] preload.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register happy-dom globals once, persistently for the entire test process.
GlobalRegistrator.register({ url: 'http://localhost/', width: 1024, height: 768 });

// matchMedia is not provided by happy-dom's global registrator, stub it.
/* eslint-disable @typescript-eslint/no-empty-function -- matchMedia stub; empty listeners intentional */
Object.defineProperty(globalThis, 'matchMedia', {
  value: (_query: string) => ({
    matches: false,
    media: _query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
  writable: true,
  configurable: true,
});
/* eslint-enable @typescript-eslint/no-empty-function */

// Patch React.act, React 19 production bundles don't export `act`, but
// react-dom/test-utils wraps calls through React.act. We provide a minimal
// synchronous pass-through so renders don't blow up.
// NOTE: tests use flushSync (react-dom) for synchronous rendering instead.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/dot-notation -- 'act' not in the React type, must use bracket access
  if (typeof React['act'] !== 'function') {
    // eslint-disable-next-line @typescript-eslint/dot-notation -- same
    React['act'] = function act(cb: () => unknown) {
      const result = cb();
      return result instanceof Promise ? result : Promise.resolve(result);
    };
  }
} catch {
  // silently skip if react isn't available
}
