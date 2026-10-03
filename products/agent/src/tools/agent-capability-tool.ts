/**
 * The `capability_status` tool: what is wired in THIS process, read from the
 * running state, not inferred from the source tree.
 *
 * The second half of the incident that produced the PATH-shadowing work. Asked
 * whether it could use Gmail, the agent reached for a code-index retrieval,
 * reasoned from what the search turned up, and recommended registering an MCP
 * server. The build it was running had no Google support at all, no
 * `google-runtime.ts`, no `google` tool, so the honest answer was "Gmail is
 * absent from this build", and instead the user got a configuration errand
 * that would never have worked. A search over files answers "what does this
 * repository contain"; the user asked "what can you do", and those are
 * different questions whenever the running build is not the source tree.
 *
 * So capability questions get a route that cannot be wrong in that direction:
 *   - the capability index is re-resolved LIVE on every call, not read from
 *     the boot snapshot, because credentials can be connected mid-session;
 *   - Google, mail and calendar additionally carry the same status report
 *     `/google status` prints, from the same function, so the answer is what
 *     the connector actually sees;
 *   - a capability with no route registered in this build is reported as
 *     absent from the build, in those words, with the fact that configuring
 *     something will not turn it on;
 *   - when the native Google route IS registered, the remedy named is the
 *     native one. Nothing here ever offers an MCP server or an SMTP server as
 *     the way to reach Gmail or Google Calendar.
 *
 * Resolving a capability performs no effects, every probe reads (see
 * capability-probe-runner.ts), so this is safe to call at any point in a
 * turn, as often as the model likes.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { readEmailConfig, validateEmailConfig } from '@goodvibes-jev/engine/sdk/platform/email';
import { buildProbeContext } from '../capabilities/capability-boot-check.ts';
import { resolveCapabilityIndex } from '../capabilities/capability-index.ts';
import { configValueIsPresent, safeMcpServerPosture, servedOperatorMethodIds } from '../capabilities/capability-sources.ts';
import type { CapabilityIndexReport, ResolvedCapability } from '../capabilities/capability-types.ts';
import { describeGoogleConnection } from '../input/commands/google-connection-actions.ts';
import { requirePlatform, requireShellPaths } from '../input/commands/runtime-services.ts';
import type { CommandContext } from '../input/command-registry.ts';

/** What a question can be about. `all` is the whole index. */
export const CAPABILITY_SUBJECTS = ['all', 'google', 'mail', 'calendar', 'browser'] as const;
export type CapabilitySubject = (typeof CAPABILITY_SUBJECTS)[number];

/** Which capability ids each subject covers, in the order they should be read. */
const SUBJECT_CAPABILITIES: Readonly<Record<Exclude<CapabilitySubject, 'all'>, readonly string[]>> = {
  google: ['email.read', 'email.send', 'calendar.read'],
  mail: ['email.read', 'email.send'],
  calendar: ['calendar.read'],
  browser: ['browser.control'],
};

/** Subjects whose answer is served by the built-in Google connector. */
const GOOGLE_BACKED: ReadonlySet<CapabilitySubject> = new Set(['google', 'mail', 'calendar']);

/** The name of the in-process tool that reaches Gmail and Google Calendar. */
export const GOOGLE_TOOL_NAME = 'google';

/**
 * The non-Google mailbox verdict: one line about the separate direct-mailbox
 * feature, so a mail question does not silently drop it.
 */
export interface MailboxVerdict {
  readonly configured: boolean;
  readonly detail: string;
}

export interface CapabilityStatusInputs {
  /** Re-resolved on every call; never the boot snapshot. */
  readonly report: CapabilityIndexReport;
  /** True when the in-process Google route is registered in this build. */
  readonly googleToolRegistered: boolean;
  /** The `/google status` report, or undefined when the subject does not need it. */
  readonly googleStatus?: string | undefined;
  /** The separate IMAP/SMTP mailbox verdict, or undefined when not asked about mail. */
  readonly mailbox?: MailboxVerdict | undefined;
}

function describeCapability(entry: ResolvedCapability): string[] {
  switch (entry.state) {
    case 'ready':
      return [`${entry.title}: available now. Call it with: ${entry.modelRoute ?? 'the registered route'}`];
    case 'needs-setup':
      return [
        `${entry.title}: not ready yet. ${entry.reason ?? 'A prerequisite is missing.'}`,
        `  Fix: ${entry.fix ?? 'unknown'}`,
      ];
    case 'unavailable':
      return [
        `${entry.title}: absent from this build. ${entry.reason ?? 'No route for it is registered here.'}`,
        '  Nothing you configure will turn this on in this build, a build that carries the route is what adds it.',
      ];
  }
}

/**
 * Renders the answer. Pure: it is handed a resolved index and the runtime
 * reports, and decides only what to say about them.
 */
export function renderCapabilityStatus(subject: CapabilitySubject, inputs: CapabilityStatusInputs): string {
  const lines: string[] = [];
  const byId = new Map(inputs.report.capabilities.map((entry) => [entry.id, entry]));
  const ids = subject === 'all'
    ? inputs.report.capabilities.map((entry) => entry.id)
    : SUBJECT_CAPABILITIES[subject];

  lines.push(`What this build can do, read from the running process at ${inputs.report.resolvedAt}.`);
  lines.push('');

  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) {
      lines.push(`${id}: absent from this build. No capability of that name is declared here.`);
      continue;
    }
    lines.push(...describeCapability(entry));
  }

  if (GOOGLE_BACKED.has(subject)) {
    lines.push('');
    lines.push(...describeGoogleRoute(inputs));
  }

  if (inputs.mailbox) {
    lines.push('');
    lines.push('A mailbox that is not Google is a separate feature with its own settings, unrelated to the above:');
    lines.push(`  ${inputs.mailbox.detail}`);
  }

  if (inputs.report.disagreements.length > 0) {
    lines.push('');
    lines.push('Configured on this machine but not reported usable, say this rather than refusing:');
    for (const disagreement of inputs.report.disagreements) {
      lines.push(`  ${disagreement.problem} Found: ${disagreement.evidence.join('; ')}. Fix: ${disagreement.fix}`);
    }
  }

  return lines.join('\n');
}

/**
 * How Gmail and Google Calendar are reached in this build.
 *
 * When the in-process route is registered, the remedy is the native one and
 * nothing else is offered, the failure this replaces was a recommendation to
 * go and configure a separate server for something the build already served
 * itself. When the route is NOT registered, the honest answer is that the
 * build does not have it, not that something needs configuring.
 */
function describeGoogleRoute(inputs: CapabilityStatusInputs): string[] {
  if (!inputs.googleToolRegistered) {
    return [
      'Gmail and Google Calendar are absent from this build: it registers no route to them.',
      'Nothing configured on this machine will turn them on here, a build that carries the route is what adds them.',
    ];
  }
  const lines = [
    'Gmail and Google Calendar run through the built-in google tool, in this process.',
    'There is nothing to install and nothing separate to register: connect an account with /google connect,',
    'or take up credentials already on this machine with /google adopt.',
  ];
  if (inputs.googleStatus) {
    lines.push('');
    lines.push('What the connector sees right now:');
    for (const line of inputs.googleStatus.split('\n')) lines.push(`  ${line}`);
  }
  return lines;
}

/** The separate direct-mailbox verdict, read from the same config `/email status` reads. */
export function readMailboxVerdict(configGet: (key: string) => unknown): MailboxVerdict {
  try {
    const config = readEmailConfig(configGet);
    const errors = validateEmailConfig(config);
    const ready = config.enabled && errors.length === 0;
    if (ready) {
      return { configured: true, detail: 'A direct mailbox is configured and ready. Manage it with: /email status' };
    }
    return {
      configured: false,
      detail: config.enabled
        ? `A direct mailbox is switched on but incomplete (${errors.length} setting(s) outstanding). See: /email status`
        : 'No direct mailbox is configured. That is a separate feature from Google; set one up with /email set only if the account is not a Google account.',
    };
  } catch {
    return { configured: false, detail: 'The direct-mailbox settings could not be read. See: /email status' };
  }
}

export interface AgentCapabilityToolOptions {
  readonly toolRegistry: ToolRegistry;
  readonly commandContext: CommandContext;
  readonly configManager: unknown;
}

export function createAgentCapabilityTool(options: AgentCapabilityToolOptions): Tool {
  /** A fresh resolution every call: credentials can be connected mid-session. */
  function resolveNow(): CapabilityIndexReport {
    return resolveCapabilityIndex(
      buildProbeContext({
        toolRegistry: options.toolRegistry,
        homeDirectory: requireShellPaths(options.commandContext).homeDirectory,
        workingDirectory: requireShellPaths(options.commandContext).workingDirectory,
        configValuePresent: (key) => configValueIsPresent(options.configManager, key),
        mcpServers: safeMcpServerPosture(options.commandContext),
        servedOperatorMethodIds: servedOperatorMethodIds(),
      }),
      { homeDirectory: requireShellPaths(options.commandContext).homeDirectory },
    );
  }

  function googleToolRegistered(): boolean {
    try {
      return options.toolRegistry.getToolDefinitions().some((tool) => tool.name === GOOGLE_TOOL_NAME);
    } catch {
      return false;
    }
  }

  return {
    definition: {
      name: 'capability_status',
      // Short by policy (72 characters). The steering that used to sit here,
      // call this rather than answering from a code search, a file listing or a
      // knowledge lookup, ships in the system prompt as CAPABILITY_ROUTE_RULE
      // (src/agent/capability-summary-prompt.ts), in fuller form and where the
      // model reads it before deciding to call anything.
      description: 'What this build can do, read from its live runtime state.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            enum: [...CAPABILITY_SUBJECTS],
            description: 'What the question is about. Defaults to all.',
          },
        },
        required: [],
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const raw = typeof args['subject'] === 'string' ? args['subject'].trim().toLowerCase() : 'all';
      const subject: CapabilitySubject = (CAPABILITY_SUBJECTS as readonly string[]).includes(raw)
        ? (raw as CapabilitySubject)
        : 'all';

      const report = resolveNow();
      const registered = googleToolRegistered();

      let googleStatus: string | undefined;
      if (registered && (GOOGLE_BACKED.has(subject) || subject === 'all')) {
        try {
          googleStatus = await describeGoogleConnection(options.commandContext);
        } catch {
          googleStatus = undefined;
        }
      }

      let mailbox: MailboxVerdict | undefined;
      if (subject === 'mail' || subject === 'all') {
        const manager = requirePlatform(options.commandContext).configManager as { get: (key: string) => unknown };
        mailbox = readMailboxVerdict((key) => manager.get(key));
      }

      return {
        success: true,
        output: renderCapabilityStatus(subject, {
          report,
          googleToolRegistered: registered,
          googleStatus,
          mailbox,
        }),
      };
    },
  };
}

export function registerAgentCapabilityTool(options: AgentCapabilityToolOptions): void {
  if (!options.toolRegistry.has('capability_status')) {
    options.toolRegistry.register(createAgentCapabilityTool(options));
  }
}
