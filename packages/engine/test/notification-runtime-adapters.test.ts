import { describe, expect, spyOn, test } from 'bun:test';
import { Notifier } from '../sdk/src/platform/integrations/notifier.ts';
import { WebhookNotifier } from '../sdk/src/platform/integrations/webhooks.ts';
import { SlackIntegration } from '../sdk/src/platform/integrations/slack.ts';
import { DiscordIntegration } from '../sdk/src/platform/integrations/discord.ts';
import { RuntimeEventBus, createEventEnvelope, type AgentEvent } from '../sdk/src/platform/runtime/events/index.ts';
import type { ContractEvent } from '../sdk/src/events/contract.ts';
import { waitFor } from './_helpers/test-timeout.ts';

type AdapterEvent = Extract<AgentEvent | ContractEvent, { type:
  'AGENT_COMPLETED' | 'AGENT_FAILED' | 'CONTRACT_PASSED' | 'CONTRACT_FAILED' | 'CONTRACT_CANCELLED'
}>;
type Adapter = 'notifier' | 'webhook';
const GENERIC = 'GoodVibes: notification available';
const SLACK_URL = 'https://example.com/runtime-slack';
const DISCORD_URL = 'https://example.com/runtime-discord';
const WEBHOOK_URL = 'https://example.com/runtime-webhook';

const fixtures: ReadonlyArray<{
  readonly payload: AdapterEvent;
  readonly notifier?: string;
  readonly webhook: string;
}> = [
  {
    payload: { type: 'AGENT_COMPLETED', agentId: 'fixture-agent', durationMs: 10, output: 'Finished the requested work' },
    notifier: 'Agent completed: Finished the requested work',
    webhook: 'Agent completed: fixture-agent',
  },
  {
    payload: { type: 'AGENT_COMPLETED', agentId: 'fixture-agent', durationMs: 10 },
    notifier: 'Agent completed: fixture-agent',
    webhook: 'Agent completed: fixture-agent',
  },
  {
    payload: { type: 'AGENT_COMPLETED', agentId: 'fixture-agent', durationMs: 10, output: 'x'.repeat(120) },
    notifier: `Agent completed: ${'x'.repeat(100)}`,
    webhook: 'Agent completed: fixture-agent',
  },
  {
    payload: { type: 'AGENT_FAILED', agentId: 'fixture-agent', error: 'The task could not finish', durationMs: 10 },
    webhook: 'Agent failed: fixture-agent, The task could not finish',
  },
  {
    payload: { type: 'CONTRACT_PASSED', contractId: 'fixture-contract', criteriaMet: 2, criteriaJudged: 3, excluded: 1, nudges: 0 },
    notifier: 'The workstream is done: 2 of 3 requirements met',
    webhook: 'The workstream passed all its checks.',
  },
  {
    payload: { type: 'CONTRACT_FAILED', contractId: 'fixture-contract', reason: 'A requirement was not met', failureKind: 'other', membersSettled: true },
    notifier: 'The workstream could not be finished: A requirement was not met',
    webhook: 'The workstream could not be finished: A requirement was not met',
  },
  {
    payload: { type: 'CONTRACT_CANCELLED', contractId: 'fixture-contract', reason: 'The request was cancelled', filesModified: 1 },
    notifier: 'The workstream was cancelled: The request was cancelled',
    webhook: 'The workstream was cancelled: The request was cancelled',
  },
];

/** Observe ordinary lazy fields without changing their values or formatting. */
function emitObserved(bus: RuntimeEventBus, source: AdapterEvent): string[] {
  const reads: string[] = [];
  const payload = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'type') continue;
    Object.defineProperty(payload, key, { get() { reads.push(key); return value; } });
  }
  const context = { sessionId: 'fixture-session', source: 'notification-adapter-test' };
  if (payload.type === 'AGENT_COMPLETED' || payload.type === 'AGENT_FAILED') {
    const event = createEventEnvelope(payload.type, payload, context);
    bus.emit('agents', { ...event, get payload() { reads.push('payload'); return payload; } });
  } else {
    const event = createEventEnvelope(payload.type, payload, context);
    bus.emit('contracts', { ...event, get payload() { reads.push('payload'); return payload; } });
  }
  return reads;
}

for (const adapter of ['notifier', 'webhook'] satisfies Adapter[]) {
  describe(`${adapter} runtime event admission`, () => {
    for (const fixture of fixtures) {
      const richText = fixture[adapter];
      if (richText === undefined) continue;
      for (const metadataOnly of [undefined, true, false]) {
        test(`${fixture.payload.type} (${richText.length} chars), metadataOnly=${metadataOnly}`, async () => {
          const sent: Array<{ url: string; text: string }> = [];
          const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = String(input);
            const body = String(init?.body);
            const text = url === SLACK_URL ? (JSON.parse(body) as { text: string }).text
              : url === DISCORD_URL ? (JSON.parse(body) as { content: string }).content : body;
            sent.push({ url, text });
            return new Response('ok');
          }, { preconnect() {} }));
          const options = { metadataOnly: metadataOnly === undefined ? undefined : () => metadataOnly };
          const notifier = adapter === 'notifier'
            ? new Notifier({ slack: new SlackIntegration(SLACK_URL), discord: new DiscordIntegration(DISCORD_URL), ...options })
            : new WebhookNotifier([WEBHOOK_URL], { force: true, ...options });
          const bus = new RuntimeEventBus();
          try {
            notifier.attachToRuntimeBus(bus);
            const reads = emitObserved(bus, fixture.payload);
            await waitFor(() => sent.length === (adapter === 'notifier' ? 2 : 1));
            const expected = metadataOnly === false ? richText : GENERIC;
            expect(sent).toEqual(adapter === 'notifier'
              ? [{ url: SLACK_URL, text: expected }, { url: DISCORD_URL, text: expected }]
              : [{ url: WEBHOOK_URL, text: expected }]);
            if (metadataOnly === false) expect(reads.length).toBeGreaterThan(0);
            else expect(reads).toEqual([]);
          } finally {
            if (notifier instanceof Notifier) await notifier.close();
            else notifier.detach();
            fetchSpy.mockRestore();
          }
        });
      }
    }
  });
}
