import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerSubscriptionRuntimeCommands } from '../../input/commands/subscription-runtime.ts';
import { registerSecurityRuntimeCommands } from '../../input/commands/security-runtime.ts';

function makeSubscriptionContext(out: string[], opened: string[]): CommandContext {
  return {
    print: (text: string) => { out.push(text); },
    openSubscriptionWorkspace: () => { opened.push('subscription'); },
    platform: {
      subscriptionManager: {
        list: () => [],
      },
      serviceRegistry: {
        getAll: () => ({}),
      },
    },
  } as unknown as CommandContext;
}

function makeSecurityContext(out: string[], opened: string[]): CommandContext {
  return {
    print: (text: string) => { out.push(text); },
    openSecurityWorkspace: () => { opened.push('security'); },
    platform: {
      readModels: {
        security: {
          getSnapshot: () => ({
            mcpServers: [],
            recentMcpDecisions: [],
          }),
        },
      },
      tokenAuditor: {
        auditAll: () => ({
          results: [],
          blocked: [],
          scopeViolations: [],
          rotationOverdue: [],
          rotationWarnings: [],
        }),
      },
      subscriptionManager: {
        list: () => [],
        listPending: () => [],
      },
    },
    extensions: {
      policyRuntimeState: {
        getSnapshot: () => ({
          lintFindings: [],
          lastPreflightReview: null,
        }),
      },
      pluginManager: {
        list: () => [],
      },
    },
  } as unknown as CommandContext;
}

describe('Agent operator command defaults', () => {
  test('/subscription defaults to transcript review instead of opening copied panels', async () => {
    const registry = new CommandRegistry();
    registerSubscriptionRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];

    await registry.execute('subscription', [], makeSubscriptionContext(out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Subscription Review');
  });

  test('/security defaults to transcript review and blocks copied panel routing', async () => {
    const registry = new CommandRegistry();
    registerSecurityRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];

    await registry.execute('security', [], makeSecurityContext(out, opened));
    await registry.execute('security', ['open'], makeSecurityContext(out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Security Review');
    expect(out.join('\n')).toContain('run /security review');
  });

  test('/policy stays absent while /security carries operator policy review', async () => {
    const registry = new CommandRegistry();
    registerSecurityRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];

    expect(registry.get('policy')).toBeUndefined();

    await registry.execute('security', [], makeSecurityContext(out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Security Review');
    expect(out.join('\n')).toContain('policy preflight');
  });
});
