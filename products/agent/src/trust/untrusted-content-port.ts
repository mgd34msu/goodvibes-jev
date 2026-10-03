/**
 * untrusted-content-port.ts, the agent's side of the platform browser's
 * untrusted-content contract.
 *
 * `BrowserEngine` takes its untrusted-content contract as a REQUIRED injected
 * port (`UntrustedContentPort`) rather than reaching for a product's module.
 * That is still the right shape: an engine constructed with no port would read
 * pages and label nothing, which is the boundary silently absent instead of a
 * compile error.
 *
 * What changed is where the port's BODY comes from. It used to be assembled
 * here, delegating to the agent's own untrusted-content module. The policy has
 * since moved into the SDK (`platform/security`), because the daemon now serves
 * `browser.*` and `email.*` with no surface attached and needed the same
 * contract, and a second copy of the rule text and refusal wording would have
 * drifted from this one. So the port itself is the SDK's factory, and this
 * module is the two facts about THIS surface that the factory needs: the
 * surface a page is labelled with, and the tool named in a refusal.
 *
 * The `surface` on every envelope is `'web-page'`: this port exists to serve
 * the browser, and mislabelling a page as some other surface would put the
 * wrong provenance in front of the reader.
 */

import type { UntrustedContentPort } from '@goodvibes-jev/engine/sdk/platform/browser';
import { createUntrustedContentPort } from '@goodvibes-jev/engine/sdk/platform/security';
import type { UntrustedContentLedger } from './untrusted-content.ts';

export interface AgentUntrustedContentPortOptions {
  /**
   * The ledger this port records into. Defaults to the process-wide session
   * ledger, which is what production wants; tests pass their own so one test's
   * page read cannot make the next test's outward action refuse.
   */
  readonly ledger?: UntrustedContentLedger;
  /** Clock seam, so envelope timestamps are assertable. */
  readonly now?: () => Date;
}

/** The agent's `UntrustedContentPort`, for handing to `new BrowserEngine(...)`. */
export function createAgentUntrustedContentPort(
  options: AgentUntrustedContentPortOptions = {},
): UntrustedContentPort {
  return createUntrustedContentPort({
    surface: 'web-page',
    toolName: 'browser',
    ...(options.ledger ? { ledger: options.ledger } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
