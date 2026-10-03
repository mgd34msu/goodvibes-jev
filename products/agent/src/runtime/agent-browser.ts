/**
 * How the agent builds a browser.
 *
 * The engine, the session manager and the provisioning policy are the SDK's
 * now, and they are deliberately surface-agnostic: they take a storage root, an
 * untrusted-content port, a host-script location and an install-kind profile
 * rather than knowing any of them. Those four answers are facts about THIS
 * product, and this is the one place that supplies them. Every engine the agent
 * constructs, the `browser` tool, the `browser` CLI command, and the Google
 * setup flow's browser step, comes through here, so a second set of wiring
 * cannot exist to drift from this one.
 *
 * The untrusted-content port is the load-bearing part. `BrowserEngineOptions`
 * requires it and defaults nothing, so an engine built anywhere else would fail
 * to compile rather than quietly read pages and label none of them.
 */

import {
  BrowserEngine,
  BrowserSessionManager,
  browserProfileRoot,
  browserScreenshotRoot,
  driverSearchDirectories,
  managedDriverRoot,
  type BrowserSessionManagerDeps,
} from '@goodvibes-jev/engine/sdk/platform/browser';
import type { UntrustedContentPort } from '@goodvibes-jev/engine/sdk/platform/browser';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { createAgentUntrustedContentPort } from '../trust/untrusted-content-port.ts';
import { recordAgentSessionWrite } from '../tools/agent-session-write-ledger.ts';

/**
 * What the agent tells someone whose browser host script is missing.
 *
 * The SDK ships no installer, so it cannot phrase this; the sentence is the
 * same one the agent printed before the host client moved.
 */
const MISSING_HOST_SCRIPT_FIX =
  'Reinstall the agent so its files are complete: bun add -g @pellux/goodvibes-agent';

/** Where saved browser profiles live, under the agent's own storage root. */
export function agentBrowserProfileRoot(homeDirectory: string): string {
  return browserProfileRoot(homeDirectory, GOODVIBES_AGENT_SURFACE_ROOT);
}

/** Where screenshots go, under the agent's own storage root. */
export function agentBrowserScreenshotRoot(homeDirectory: string): string {
  return browserScreenshotRoot(homeDirectory, GOODVIBES_AGENT_SURFACE_ROOT);
}

/** The directory a driver the agent installs for itself lands in. */
export function agentManagedDriverRoot(homeDirectory: string): string {
  return managedDriverRoot(homeDirectory, GOODVIBES_AGENT_SURFACE_ROOT);
}

/**
 * Every place the runtime loads the driver from, in order, the same list the
 * capability probe reports, so the index agrees with what the browser tool
 * finds a moment later rather than merely looking in the same places.
 */
export function agentDriverSearchDirectories(homeDirectory: string): readonly string[] {
  return driverSearchDirectories({ homeDirectory, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT });
}

export interface AgentBrowserSessionManagerOptions {
  readonly profileRoot: string;
  readonly homeDirectory: string;
  /** Test seams, forwarded to the SDK manager unchanged. */
  readonly io?: BrowserSessionManagerDeps['io'];
  readonly loadDriver?: BrowserSessionManagerDeps['loadDriver'];
  readonly probeEndpoint?: BrowserSessionManagerDeps['probeEndpoint'];
}

export function createAgentBrowserSessionManager(
  options: AgentBrowserSessionManagerOptions,
): BrowserSessionManager {
  return new BrowserSessionManager({
    profileRoot: options.profileRoot,
    homeDirectory: options.homeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    host: { missingScriptFix: MISSING_HOST_SCRIPT_FIX },
    ...(options.io ? { io: options.io } : {}),
    ...(options.loadDriver ? { loadDriver: options.loadDriver } : {}),
    ...(options.probeEndpoint ? { probeEndpoint: options.probeEndpoint } : {}),
  });
}

export interface AgentBrowserEngineOptions {
  readonly screenshotDirectory: string;
  readonly profileRoot: string;
  readonly homeDirectory: string;
  /**
   * The untrusted-content contract handed to the engine. Defaults to the
   * agent's port over the process-wide session ledger every other ingesting
   * surface writes to; tests inject their own so one case's page read cannot
   * make the next case's outward action refuse.
   */
  readonly untrusted?: UntrustedContentPort;
}

/** The agent's browser: an SDK engine with this product's four answers bound in. */
export function createAgentBrowserEngine(options: AgentBrowserEngineOptions): BrowserEngine {
  return new BrowserEngine(
    createAgentBrowserSessionManager({
      profileRoot: options.profileRoot,
      homeDirectory: options.homeDirectory,
    }),
    {
      screenshotDirectory: options.screenshotDirectory,
      untrusted: options.untrusted ?? createAgentUntrustedContentPort(),
      // The engine KNOWS it just created this exact file, which is the case
      // the explicit session-write entry point exists for: the tool-event
      // classifier deliberately refuses a waiver for browser writes because
      // those paths did not pass through the model.
      recordSessionWrite: recordAgentSessionWrite,
    },
  );
}
