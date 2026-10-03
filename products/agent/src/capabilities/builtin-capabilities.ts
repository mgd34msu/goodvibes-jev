import { join } from 'node:path';
import { DRIVER_REQUIRED_FILES } from '@goodvibes-jev/engine/sdk/platform/browser';
import { driverRemediation } from '../runtime/browser-driver-profile.ts';
import { agentDriverSearchDirectories } from '../runtime/agent-browser.ts';
import { registerCapability, registerFallbackCapability } from './capability-index.ts';
import type { CapabilityDeclaration, CapabilityPrerequisite, CapabilityProbe } from './capability-types.ts';

/**
 * The capabilities this build declares for itself.
 *
 * Two kinds live here. Real ones, browser control, declare the route they are
 * actually invoked through. Placeholders, email and calendar, declare what
 * the agent would need in order to do something it cannot do yet, so the index
 * can answer "not yet, and here is exactly why" instead of "no". A provider
 * that implements one of those ids later registers over the placeholder.
 */

export interface BuiltinCapabilityOptions {
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}

/**
 * Browser control, described the way it actually behaves.
 *
 * The driver prerequisite is deliberately OPTIONAL, and that is the whole point
 * of this declaration. In 1.18.1 it was blocking and probed by module
 * resolution alone, which can never succeed inside a compiled binary, so every
 * binary install reported "the browser driver is missing, reinstall the agent",
 * the model relayed that instead of calling the tool, and the tool's own
 * one-act provisioning (which installs the driver on first use) never got a
 * chance to run. A prerequisite the tool provisions for itself is not something
 * the user has to supply, so it does not block; it only annotates.
 *
 * When the driver genuinely cannot be obtained, the failure is reported at call
 * time by the provisioning policy, which has actually tried and can name what
 * stopped it. That is the honest place for it, a probe cannot know.
 */
export function browserControlDeclaration(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'browser.control',
    title: 'Use a web browser',
    summary: 'Open web pages, read them, click, type, fill forms, and take screenshots, with a saved profile that keeps sign-ins between runs. The browser driver and browser install themselves on the first call if they are not already there, which takes a minute or two once.',
    provider: 'goodvibes-agent built-in browser tool',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'browser',
        modelRoute: 'browser action:"navigate" url:"..."',
        availability: { kind: 'model-tool-registered', toolName: 'browser' },
      },
    ],
    prerequisites: [
      {
        id: 'playwright-driver',
        label: 'The browser driver',
        probe: {
          kind: 'module-resolvable',
          specifier: 'playwright-core',
          label: 'The browser driver',
          // The exact places the runtime loads it from, AND the exact
          // completeness rule it applies, so the index agrees with what the
          // browser tool will find a moment later rather than merely looking in
          // the same places.
          // Resolved against the AGENT's storage root, so the index reports on
          // the same directory the browser tool will install into rather than
          // on some other surface's.
          searchDirectories: agentDriverSearchDirectories(options.homeDirectory),
          requiredFiles: DRIVER_REQUIRED_FILES,
        },
        optional: true,
        fix: driverRemediation(),
      },
    ],
  };
}

/**
 * The Google account, and what it makes possible.
 *
 * These were placeholders describing a build that could not send mail. They
 * declared their only route as the daemon operator method `email.send`, which
 * the operator contract carries with `invokable: false`, meaning no daemon
 * dispatch chain serves it. A capability whose sole route is permanently
 * un-invokable resolves to `unavailable` before prerequisites are even read, so
 * configuring a mailbox or adopting credentials moved nothing, and the owner
 * was told email was "not wired into this build" while working credentials sat
 * on disk.
 *
 * They now declare the route that is actually served: the in-process `google`
 * tool, backed by the native connector. The prerequisite is a credential from
 * either source the connector genuinely reads, its own encrypted store, or an
 * existing install on this machine, so a machine that has one reports ready
 * and a machine that has neither reports the one step that fixes it.
 */

/** The credential sources the connector actually reads, in the order it reads them. */
function googleAccountProbe(options: BuiltinCapabilityOptions): CapabilityProbe {
  return {
    kind: 'any-of',
    label: 'A connected Google account',
    probes: [
      {
        kind: 'config-value-present',
        key: 'calendar.google.clientId',
        label: 'A Google account connected through the built-in setup',
      },
      {
        kind: 'any-file-present',
        paths: [
          join(options.homeDirectory, '.gmail-mcp', 'gcp-oauth.keys.json'),
          join(options.homeDirectory, '.gmail-mcp', 'google-workspace-credentials.json'),
          join(options.homeDirectory, '.gmail-mcp', 'credentials.json'),
        ],
        label: 'Google credentials already on this machine',
      },
    ],
  };
}

const GOOGLE_ACCOUNT_FIX = 'Connect a Google account with: /google connect, it works out the shortest route and asks you to approve one consent link';

function googlePrerequisite(options: BuiltinCapabilityOptions): CapabilityPrerequisite {
  return {
    id: 'google-account',
    label: 'A connected Google account',
    probe: googleAccountProbe(options),
    fix: GOOGLE_ACCOUNT_FIX,
  };
}

function emailSend(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'email.send',
    title: 'Send email',
    summary: 'Send a message from the owner\'s mailbox.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"mail.send" to:"..." subject:"..." body:"..." confirm:true',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
    ],
    prerequisites: [googlePrerequisite(options)],
    configurationEvidence: [googleAccountProbe(options)],
  };
}

function emailRead(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'email.read',
    title: 'Read email',
    summary: 'Read messages from the owner\'s mailbox.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"mail.list" query:"..."',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
    ],
    prerequisites: [googlePrerequisite(options)],
    configurationEvidence: [googleAccountProbe(options)],
  };
}

function calendarRead(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'calendar.read',
    title: 'Read the calendar',
    summary: 'See what is on the owner\'s calendar.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"calendar.list"',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
    ],
    prerequisites: [googlePrerequisite(options)],
    configurationEvidence: [
      googleAccountProbe(options),
      // A private ICS feed reads a calendar without OAuth at all.
      {
        kind: 'config-value-present',
        key: 'calendar.google.icsUrl',
        label: 'A private calendar feed address',
      },
    ],
  };
}

export function registerBuiltinCapabilities(options: BuiltinCapabilityOptions): void {
  registerCapability(browserControlDeclaration(options));
  registerFallbackCapability(emailSend(options));
  registerFallbackCapability(emailRead(options));
  registerFallbackCapability(calendarRead(options));
}
