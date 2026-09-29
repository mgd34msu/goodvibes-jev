/**
 * `mentioned` means THIS bot was mentioned, not that the message mentions
 * someone. Slack's plain `message` events and Discord's gateway messages used
 * to set it for a mention of any user, so a channel policy that only answers
 * when the bot is addressed answered a message addressed to a colleague.
 */
import { describe, expect, test } from 'bun:test';
import { handleSlackSurfacePayload } from '../sdk/src/platform/adapters/slack/index.js';
import { handleDiscordGatewayDispatchPayload } from '../sdk/src/platform/adapters/discord/index.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/index.js';

/** A context that records the ingress input and stops there (the policy refuses). */
function capturingContext(config: Record<string, unknown> = {}) {
  const ingress: Array<{ readonly mentioned?: boolean }> = [];
  const context = {
    configManager: { get: (key: string) => config[key] },
    authorizeSurfaceIngress: async (input: { readonly mentioned?: boolean }) => {
      ingress.push(input);
      return { allowed: false, reason: 'test stops here' };
    },
    parseSurfaceControlCommand: () => null,
  } as unknown as SurfaceAdapterContext;
  return { context, ingress };
}

function slackMessage(text: string) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true }],
    event: { type: 'message', text, user: 'UALICE', channel: 'C1', ts: '1.0' },
  };
}

describe('slack: a message mentions the bot only when it names the bot user', () => {
  test('a mention of another user is not a mention of the bot', async () => {
    const { context, ingress } = capturingContext();
    await handleSlackSurfacePayload(slackMessage('<@UBOB> can you look at this?'), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test("a mention of the bot's user id is", async () => {
    const { context, ingress } = capturingContext();
    await handleSlackSurfacePayload(slackMessage('<@UBOT|goodvibes> can you look at this?'), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('an app_mention event is always a mention', async () => {
    const { context, ingress } = capturingContext();
    const body = slackMessage('hello');
    await handleSlackSurfacePayload({ ...body, event: { ...body.event, type: 'app_mention' } }, context);
    expect(ingress[0]?.mentioned).toBe(true);
  });
});

function discordMessage(mentions: readonly { readonly id: string }[]) {
  return {
    t: 'MESSAGE_CREATE',
    d: { id: 'm1', channel_id: 'c1', guild_id: 'g1', content: 'can you look at this?', author: { id: 'alice' }, mentions },
  };
}

describe('discord: a message mentions the bot only when a mention carries its application id', () => {
  const config = { 'surfaces.discord.applicationId': '111' };

  test('a mention of another user is not a mention of the bot', async () => {
    const { context, ingress } = capturingContext(config);
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '222' }]), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test("a mention of the bot's id is", async () => {
    const { context, ingress } = capturingContext(config);
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '222' }, { id: '111' }]), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('with no application id configured, no mention can be matched to the bot', async () => {
    const { context, ingress } = capturingContext();
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '111' }]), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });
});
