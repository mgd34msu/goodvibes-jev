import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { beforeEach, describe, expect, test } from 'bun:test';
import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createAgentNotifyTool,
  registerAgentNotifyTool,
} from '../../tools/agent-notify-tool.ts';

interface NotifyCalls {
  readonly setUrls: string[][];
  readonly sends: string[];
}

function configManager(urls: readonly string[]) {
  return {
    getCategory: () => ({ webhookUrls: [...urls] }),
  };
}

function notifier(calls: NotifyCalls) {
  return {
    setUrls: (urls: string[]) => {
      calls.setUrls.push([...urls]);
    },
    send: async (text: string) => {
      calls.sends.push(text);
      return {
        attempted: 1,
        delivered: 1,
        failed: 0,
        results: [{ ok: true, url: 'https://ntfy.sh/goodvibes-agent-alerts' }],
      };
    },
  };
}

function calls(): NotifyCalls {
  return {
    setUrls: [],
    sends: [],
  };
}

beforeEach(() => resetSessionUntrustedContentLedgerForTests());

describe('agent_notify tool', () => {
  test('explicit preview reads configured targets without sending', async () => {
    const sent = calls();
    const tool = createAgentNotifyTool(
      configManager(['https://ntfy.sh/goodvibes-agent-alerts']),
      notifier(sent),
    );

    const result = await tool.execute({
      message: 'Review the approvals',
      preview: true,
      explicitUserRequest: 'Tell me when approvals need review.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent notification preview');
    expect(result.output).toContain('configured targets: 1');
    expect(sent.setUrls).toEqual([]);
    expect(sent.sends).toEqual([]);
  });

  test('raw caller confirmation and request text cannot grant sending', async () => {
    const sent = calls();
    const tool = createAgentNotifyTool(
      configManager(['https://ntfy.sh/goodvibes-agent-alerts']),
      notifier(sent),
    );

    const result = await tool.execute({
      message: 'Review the approvals',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('held');
    expect(sent.setUrls).toEqual([]);
    expect(sent.sends).toEqual([]);
  });

  test('recorded admission sends without confirmation fields', async () => {
    const sent = calls();
    const tool = createAgentNotifyTool(
      configManager(['https://ntfy.sh/goodvibes-agent-alerts']),
      notifier(sent),
    );

    const result = await executeAdmitted(tool, {
      message: 'Review the approvals',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent notification sent');
    expect(result.output).toContain('attempted: 1');
    expect(result.output).not.toContain('https://ntfy.sh/goodvibes-agent-alerts');
    expect(sent.setUrls).toEqual([['https://ntfy.sh/goodvibes-agent-alerts']]);
    expect(sent.sends).toEqual(['Review the approvals']);
  });

  test('fails closed when no notification targets are configured', async () => {
    const sent = calls();
    const tool = createAgentNotifyTool(configManager([]), notifier(sent));

    const result = await tool.execute({
      message: 'Review the approvals',
      confirm: true,
      explicitUserRequest: 'Send a notification to review approvals.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No Agent notification webhook targets are configured');
    expect(sent.setUrls).toEqual([]);
    expect(sent.sends).toEqual([]);
  });

  test('is registered in the model tool registry', () => {
    const registry = new ToolRegistry();

    registerAgentNotifyTool(
      registry,
      configManager(['https://ntfy.sh/goodvibes-agent-alerts']),
      notifier(calls()),
    );

    expect(registry.has('agent_notify')).toBe(true);
  });
});
