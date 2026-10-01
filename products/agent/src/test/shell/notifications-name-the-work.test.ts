/**
 * Notifications name the work (owner ruling 2026-09-29), agent side.
 *
 * The agent's own notification paths: the approval alert (this file drives the
 * real wrapper and reads the text through its notify seam) and the settings
 * workspace row for behavior.notificationsMetadataOnly. The end-of-turn popup
 * and the webhook bodies come from the SDK (orchestrator finalizeTurn and
 * WebhookNotifier), covered by the SDK's turn-notification tests.
 */
import { describe, expect, test } from 'bun:test';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { wrapRequestPermissionWithApprovalAlert } from '../../shell/terminal-focus-mode.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';

const ASK = 'Refactor the authentication middleware so expired sessions redirect to the login page instead of throwing a 500 error';

function request(): PermissionPromptRequest {
  return {
    callId: 'c1',
    tool: 'exec',
    category: 'execute' as PermissionPromptRequest['category'],
    args: { commands: [{ cmd: 'bun test src/auth/middleware.test.ts' }] },
    analysis: {} as PermissionPromptRequest['analysis'],
  };
}

async function alertText(config: Record<string, unknown>): Promise<Array<{ title: string; body: string }>> {
  const notified: Array<{ title: string; body: string }> = [];
  const wrapped = wrapRequestPermissionWithApprovalAlert((async () => ({ approved: true, remember: false })) as never, {
    focusTracker: new FocusTracker(),
    notify: (title, body) => { notified.push({ title, body }); },
    configGet: (key) => config[key],
    conversation: { title: 'first message of the session', getTitleSource: () => 'system', getLastUserMessage: () => ASK },
  });
  await wrapped(request());
  return notified;
}

describe('the agent approval alert names the work', () => {
  test('privacy setting off (default): names the command and the turn, trimmed at a word boundary', async () => {
    const [notice] = await alertText({});
    expect(notice).toEqual({
      title: 'Approval needed: Refactor the authentication middleware…',
      body: 'exec is waiting for approval: bun test src/auth/middleware.test.ts',
    });
    expect(notice!.title.length).toBeLessThanOrEqual(60);
  });

  test('privacy setting on: tool and category only', async () => {
    expect(await alertText({ 'behavior.notificationsMetadataOnly': true })).toEqual([
      { title: 'GoodVibes: approval needed', body: 'exec (execute) is waiting for approval' },
    ]);
  });
});

describe('the privacy setting is real and configurable in the agent', () => {

  test('the Agent Workspace Behavior card has a toggle for it next to the long-turn notification toggle', () => {
    const behavior = AGENT_WORKSPACE_CATEGORIES.find((category) => category.id === 'assistant-behavior');
    const ids = (behavior?.actions ?? []).map((action) => action.id);
    const index = ids.indexOf('behavior-notifications-metadata-only');
    expect(index).toBe(ids.indexOf('behavior-notify-complete') + 1);
    const action = behavior!.actions[index]!;
    expect(JSON.stringify(action)).toContain('behavior.notificationsMetadataOnly');
  });
});
