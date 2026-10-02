import { describe, expect, test } from 'bun:test';
import {
  readMailboxVerdict,
  renderCapabilityStatus,
  type CapabilityStatusInputs,
} from '../../tools/agent-capability-tool.ts';
import { buildCapabilitySummaryPrompt, CAPABILITY_ROUTE_RULE } from '../../agent/capability-summary-prompt.ts';
import type { CapabilityIndexReport, CapabilityState, ResolvedCapability } from '../../capabilities/capability-types.ts';
import type { CommandContext as CommandContextLike } from '../../input/command-registry.ts';

/**
 * Capability answers come from runtime state, not from a search.
 *
 * Asked whether it could use Gmail, the agent reached for a code-index
 * retrieval, reasoned from what it found, and told its owner to go and
 * register an MCP server. The build it was running carried no Google support
 * at all, so the honest answer was "Gmail is absent from this build", and
 * the answer it gave was a configuration errand that could never have worked.
 * These tests pin both halves: what a build WITH the native Google route says
 * when nothing is connected yet, and what a build WITHOUT it says.
 */

function capability(
  id: string,
  state: CapabilityState,
  extra: Partial<ResolvedCapability> = {},
): ResolvedCapability {
  return {
    id,
    title: extra.title ?? id,
    summary: '',
    provider: 'test',
    state,
    modelRoute: extra.modelRoute ?? null,
    invocationKind: extra.invocationKind ?? null,
    reason: extra.reason ?? null,
    fix: extra.fix ?? null,
    prerequisites: [],
  };
}

function report(capabilities: readonly ResolvedCapability[]): CapabilityIndexReport {
  return {
    resolvedAt: '2026-07-27T00:00:00.000Z',
    capabilities,
    ready: capabilities.filter((entry) => entry.state === 'ready').map((entry) => entry.id),
    needsSetup: capabilities.filter((entry) => entry.state === 'needs-setup').map((entry) => entry.id),
    unavailable: capabilities.filter((entry) => entry.state === 'unavailable').map((entry) => entry.id),
    disagreements: [],
  };
}

/** A build that carries the native route, with no account connected yet. */
const GOOGLE_UNCONFIGURED: CapabilityStatusInputs = {
  googleToolRegistered: true,
  googleStatus: [
    'Google connection',
    '  no account connected',
    '',
    'Credentials already on this machine',
    '  none found',
  ].join('\n'),
  report: report([
    capability('email.read', 'needs-setup', {
      title: 'Read Gmail',
      reason: 'No Google account is connected.',
      fix: 'Connect one with: /google connect',
    }),
    capability('email.send', 'needs-setup', {
      title: 'Send Gmail',
      reason: 'No Google account is connected.',
      fix: 'Connect one with: /google connect',
    }),
    capability('calendar.read', 'needs-setup', {
      title: 'Read Google Calendar',
      reason: 'No Google account is connected.',
      fix: 'Connect one with: /google connect',
    }),
  ]),
};

describe('a Google question with nothing connected answers from runtime state', () => {
  const answer = renderCapabilityStatus('google', GOOGLE_UNCONFIGURED);

  test('it names the native route and the exact step that connects an account', () => {
    expect(answer).toContain('built-in google tool');
    expect(answer).toContain('/google connect');
    expect(answer).toContain('/google adopt');
  });

  test('it carries what the connector itself reports, not what a search found', () => {
    expect(answer).toContain('What the connector sees right now:');
    expect(answer).toContain('Google connection');
    expect(answer).toContain('no account connected');
  });

  test('it never offers an MCP server or an SMTP server as the remedy', () => {
    expect(answer).not.toContain('MCP');
    expect(answer).not.toContain('mcp');
    expect(answer).not.toContain('SMTP');
    expect(answer).not.toContain('smtp');
    expect(answer).not.toContain('IMAP');
  });

  test('"not connected yet" is never rendered as "absent from this build"', () => {
    expect(answer).not.toContain('absent from this build');
  });
});

describe('a build that genuinely lacks the route says so', () => {
  const answer = renderCapabilityStatus('google', {
    googleToolRegistered: false,
    report: report([
      capability('email.read', 'unavailable', {
        title: 'Read Gmail',
        reason: 'No route to Gmail is registered in this build.',
      }),
    ]),
  });

  test('it says the capability is absent from the build, and that configuring will not add it', () => {
    expect(answer).toContain('absent from this build');
    expect(answer).toContain('Nothing you configure will turn this on in this build');
    expect(answer).toContain('a build that carries the route is what adds them');
  });

  test('it does not send the user off to configure a separate server', () => {
    expect(answer).not.toContain('MCP');
    expect(answer).not.toContain('SMTP');
    expect(answer).not.toContain('/google connect');
  });

  test('a capability id the build does not declare at all is reported, not silently dropped', () => {
    const missing = renderCapabilityStatus('calendar', {
      googleToolRegistered: false,
      report: report([]),
    });
    expect(missing).toContain('calendar.read: absent from this build');
  });
});

describe('a mail question keeps Google and a direct mailbox apart', () => {
  const answer = renderCapabilityStatus('mail', {
    ...GOOGLE_UNCONFIGURED,
    mailbox: readMailboxVerdict(() => undefined),
  });

  test('the Google remedy comes first and a direct mailbox is named as a separate feature', () => {
    const googleFix = answer.indexOf('/google connect');
    const mailboxMention = answer.indexOf('/email set');
    expect(googleFix).toBeGreaterThan(-1);
    expect(mailboxMention).toBeGreaterThan(googleFix);
    expect(answer).toContain('A mailbox that is not Google is a separate feature');
    expect(answer).toContain('only if the account is not a Google account');
  });
});

describe('readMailboxVerdict reads the same settings /email status reads', () => {
  test('an unconfigured mailbox is reported as not configured, with the Google caveat', () => {
    const verdict = readMailboxVerdict(() => undefined);
    expect(verdict.configured).toBe(false);
    expect(verdict.detail).toContain('No direct mailbox is configured');
  });

  test('a switched-on but incomplete mailbox is not reported as ready', () => {
    const verdict = readMailboxVerdict((key) => (key === 'email.enabled' ? true : undefined));
    expect(verdict.configured).toBe(false);
    expect(verdict.detail).toContain('/email status');
  });

  test('settings that cannot be read do not throw and do not claim readiness', () => {
    const verdict = readMailboxVerdict(() => {
      throw new Error('no config here');
    });
    expect(verdict.configured).toBe(false);
  });
});

describe('a ready capability is answered with the call to make', () => {
  test('the model route is stated rather than described', () => {
    const answer = renderCapabilityStatus('browser', {
      googleToolRegistered: true,
      report: report([
        capability('browser.control', 'ready', {
          title: 'Use a web browser',
          modelRoute: 'browser action:"navigate" url:"..."',
        }),
      ]),
    });
    expect(answer).toContain('available now. Call it with: browser action:"navigate" url:"..."');
  });
});

describe('the prompt sends capability questions to the live route', () => {
  test('the rule names the tool, rules out a code search, and rules out the wrong remedy', () => {
    expect(CAPABILITY_ROUTE_RULE).toContain('capability_status');
    expect(CAPABILITY_ROUTE_RULE).toContain('code search');
    expect(CAPABILITY_ROUTE_RULE).toContain('Never tell the user to set up an MCP server');
    expect(CAPABILITY_ROUTE_RULE).toContain('SMTP server in order to reach Gmail');
  });

  test('it ships whether or not the index resolved', () => {
    expect(buildCapabilitySummaryPrompt(null)).toContain(CAPABILITY_ROUTE_RULE);
    expect(buildCapabilitySummaryPrompt(report([capability('browser.control', 'ready')])))
      .toContain(CAPABILITY_ROUTE_RULE);
  });
});

/**
 * The wiring, not just the wording: the tool registers, resolves the index
 * live on each call, and answers without any of the heavy Google plumbing
 * when this build has no Google route.
 */
describe('the tool as it is actually registered', () => {
  function fakeContext(configValues: Record<string, unknown> = {}) {
    return {
      workspace: {
        shellPaths: {
          homeDirectory: '/home/owner',
          workingDirectory: '/home/owner/project',
        },
      },
      platform: {
        configManager: { get: (key: string) => configValues[key] },
      },
    } as unknown as CommandContextLike;
  }

  test('it registers once under the name the prompt rule names', async () => {
    const { createToolRegistryDouble } = await import('../helpers/tool-registry-double.ts');
    const { registerAgentCapabilityTool } = await import('../../tools/agent-capability-tool.ts');
    const registry = createToolRegistryDouble();
    const options = { toolRegistry: registry, commandContext: fakeContext() as never, configManager: {} };
    registerAgentCapabilityTool(options);
    registerAgentCapabilityTool(options);
    expect(registry.getToolDefinitions().filter((tool) => tool.name === 'capability_status')).toHaveLength(1);
  });

  test('the model is told not to answer capability questions from a search', async () => {
    const { createToolRegistryDouble } = await import('../helpers/tool-registry-double.ts');
    const { createAgentCapabilityTool } = await import('../../tools/agent-capability-tool.ts');
    const tool = createAgentCapabilityTool({
      toolRegistry: createToolRegistryDouble(),
      commandContext: fakeContext() as never,
      configManager: {},
    });
    // The tool's own description says where its answer comes from. It is held
    // to a 72-character budget (package-verification.ts), so the rest of the
    // steering ships in the system prompt instead of being restated here.
    expect(tool.definition.description).toContain('live runtime state');

    // Where it went (also asserted on its own above).
    expect(CAPABILITY_ROUTE_RULE).toContain('code search');
    expect(CAPABILITY_ROUTE_RULE).toContain('capability_status');
  });

  test('a Google question in a build with no google tool answers absent-from-build, live', async () => {
    const { createToolRegistryDouble } = await import('../helpers/tool-registry-double.ts');
    const { createAgentCapabilityTool } = await import('../../tools/agent-capability-tool.ts');
    const { resetCapabilityIndexForTests } = await import('../../capabilities/capability-index.ts');
    const { registerBuiltinCapabilities } = await import('../../capabilities/builtin-capabilities.ts');
    resetCapabilityIndexForTests();
    registerBuiltinCapabilities({ homeDirectory: '/home/owner', workingDirectory: '/home/owner/project' });

    const tool = createAgentCapabilityTool({
      toolRegistry: createToolRegistryDouble(),
      commandContext: fakeContext() as never,
      configManager: { get: () => undefined },
    });
    const result = await tool.execute({ subject: 'google' }, {} as never);
    expect(result.success).toBe(true);
    const output = (result as { output: string }).output;
    expect(output).toContain('read from the running process at');
    expect(output).toContain('absent from this build');
    expect(output).not.toContain('MCP');
    expect(output).not.toContain('SMTP');
  });

  test('an unrecognised subject falls back to the whole index rather than erroring', async () => {
    const { createToolRegistryDouble } = await import('../helpers/tool-registry-double.ts');
    const { createAgentCapabilityTool } = await import('../../tools/agent-capability-tool.ts');
    const { resetCapabilityIndexForTests } = await import('../../capabilities/capability-index.ts');
    const { registerBuiltinCapabilities } = await import('../../capabilities/builtin-capabilities.ts');
    resetCapabilityIndexForTests();
    registerBuiltinCapabilities({ homeDirectory: '/home/owner', workingDirectory: '/home/owner/project' });

    const tool = createAgentCapabilityTool({
      toolRegistry: createToolRegistryDouble(),
      commandContext: fakeContext() as never,
      configManager: { get: () => undefined },
    });
    const result = await tool.execute({ subject: 'something else entirely' }, {} as never);
    expect(result.success).toBe(true);
  });
});
