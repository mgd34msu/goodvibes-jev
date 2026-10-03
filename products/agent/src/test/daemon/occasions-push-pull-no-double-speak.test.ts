/**
 * Push AND pull, and one thing said once, proved through the real daemon.
 *
 * The owner's ruling is Telegram AND the agent (docs/occasions.md §4.2), so this
 * product is both a push destination and the surface that pulls. The guard that
 * stops the same birthday being raised twice is the daemon's, over the ONE open
 * item both paths read: a push that LANDS on the agent stamps the item, and while
 * the agent is a configured push destination `occasions.pending` leaves stamped
 * items out.
 *
 * That guard is the SDK's, so this file does not re-implement it, it proves this
 * product is on the right side of it, end to end: a real composed runtime, the
 * real `occasions.*` verb handlers, the real ChannelDeliveryRouter with its real
 * agent strategy, a real owner-profile file on disk, and this repo's own sender
 * registered on the router. The only stub is the conversation the message lands
 * in, which is the one part that would need a terminal.
 *
 * The two outcomes get their OWN runtime rather than running in sequence, and
 * that is not tidiness. A raised nudge moves its open item's due date on by the
 * configured cadence, so a second sweep the same day correctly raises nothing,
 * sequencing "push fails" and then "push lands" against one runtime would test the
 * cadence and call it the stamp.
 *
 *  1. sender registered  → the push lands verbatim, the pull then goes quiet, and
 *     the answer/interview loop is reached exactly as it is after a pull.
 *  2. no sender          → the SDK's NAMED error is recorded, nothing lands, and
 *     the pull STILL raises it. This is the case the stamp must not cover: a send
 *     that could not land may not cost him the nudge, and a guard that got this
 *     wrong would fail silently.
 *
 * ── Whose composition this drives ────────────────────────────────────────
 *
 * `buildDaemonGatewayCatalog(services)` builds the catalog THE DAEMON composes
 * over this graph, the agent's own `services.gatewayMethods` carries no handler
 * for any of these any more, and that absence is itself pinned in
 * daemon/gateway-ws-only-invokable.test.ts.
 *
 * The behaviour below did not move or change; its OWNER did. These verbs are
 * served to every surface by one process now, and this suite is where the
 * contract that surface depends on stays honest. Driving it through the
 * daemon's composition is the difference between verifying a contract and
 * asserting that a client answers its own question.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { buildDaemonGatewayCatalog } from '../helpers/daemon-gateway.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { makeLongLivedProjectTempDir } from '../helpers/project-temp.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createAgentConversationSender } from '../../runtime/agent-conversation-sender.ts';

/** A date a few days out, so it sits inside the default ten-day lead window. */
function annualDateSoon(): string {
  const when = new Date();
  when.setDate(when.getDate() + 3);
  return `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

interface Harness {
  readonly root: string;
  readonly profilePath: string;
  readonly services: RuntimeServices;
  readonly said: string[];
  readonly invoke: (id: string, body?: Record<string, unknown>) => Promise<unknown>;
}

const roots: string[] = [];

function harness(): Harness {
  const root = makeLongLivedProjectTempDir('gv-agent-occasions-push');
  roots.push(root);
  const daemonHome = join(root, '.goodvibes', 'daemon');
  mkdirSync(daemonHome, { recursive: true });
  const profilePath = join(daemonHome, 'owner-profile.md');
  // A real profile file with one gift-giving occasion inside its lead window,
  // written as prose lines exactly as he would hand-write them.
  writeFileSync(
    profilePath,
    ['# Owner profile', '', '## Important dates', '',
      `- Sarah birthday · ${annualDateSoon()} · annual · gift-giving · for Sarah`, ''].join('\n'),
    'utf8',
  );

  const configManager = new ConfigManager({
    surfaceRoot: 'agent',
    configDir: join(root, '.goodvibes', 'global-agent'),
    workingDir: root,
    homeDir: root,
  });
  // `profile.path` is the FIRST entry in the daemon's resolution order, and it is
  // set here for a reason that is not convenience: without it the resolver falls
  // through to GOODVIBES_DAEMON_HOME and then to the real `os.homedir()`, because
  // the gateway registrar composes the profile without a daemon-home argument and
  // this runtime's `homeDir` is not consulted for it. A test that read the
  // developer's own profile would be reading his family's birthdays, and would
  // pass or fail depending on whose machine ran it.
  configManager.set('profile.path', profilePath);
  // The agent as the ONLY push destination, so the stamp's effect on the pull is
  // unambiguous. His real configuration is `telegram,agent`; the list mechanics
  // belong to the SDK and are tested there.
  configManager.set('occasions.nudgeChannel', 'agent');
  // An always-active window, because this suite's subject is push/pull
  // coordination and not quiet hours. Left at the default 08:00-22:00 these tests
  // pass or fail on the wall clock of whoever runs them, which is how the first
  // draft of this file "proved" the guard while actually observing a held sweep.
  // start === end is the SDK's own documented "no restriction" form. Quiet hours
  // are a real rule with their own tests in the SDK.
  configManager.set('occasions.activeHours', '00:00-00:00');

  const said: string[] = [];
  const services = createRuntimeServices({
    modelDiscovery: 'skip',
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    workingDir: root,
    homeDirectory: root,
    getConversationTitle: () => 'occasions-push-test',
  });

  return {
    root,
    profilePath,
    services,
    said,
    invoke: (id, body = {}) => buildDaemonGatewayCatalog(services).invoke(id, { methodId: id, body } as never),
  };
}

function registerSender(h: Harness): () => void {
  return h.services.channelDeliveryRouter.agentDelivery.register(
    createAgentConversationSender({
      primaryConversation: () => ({ addAssistantMessage: (content: string) => { h.said.push(content); } }),
      requestRender: () => undefined,
    }),
  );
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the seeded profile is this runtime\'s own, never the real home', () => {
  const h = harness();

  test('the daemon resolved the profile inside the temp root, and the line parsed', async () => {
    // Asserted rather than assumed: this is what keeps the suite off the
    // developer's own owner-profile.md, and off his family's birthdays.
    const status = await h.invoke('profile.status') as { path: string };
    expect(status.path).toBe(h.profilePath);
    expect(status.path.startsWith(h.root)).toBe(true);

    const list = await h.invoke('occasions.list') as {
      occasions: readonly unknown[];
      unparsed: readonly unknown[];
    };
    // A grammar failure here would otherwise surface as a confusing "nothing is
    // due" further down.
    expect(list.unparsed).toEqual([]);
    expect(list.occasions).toHaveLength(1);
  });
});

describe('sender registered: the push lands and the pull goes quiet', () => {
  const h = harness();
  let undo: (() => void) | null = null;
  let pushedMessage = '';

  test('registering this repo\'s sender makes the destination live', () => {
    expect(h.services.channelDeliveryRouter.agentDelivery.registered).toBe(false);
    undo = registerSender(h);
    expect(h.services.channelDeliveryRouter.agentDelivery.registered).toBe(true);
    expect(h.services.channelDeliveryRouter.agentDelivery.current()?.id).toBe('goodvibes-agent:conversation');
  });

  test('a second sender is refused rather than silently winning the destination', () => {
    // Two conversations both claiming to be THE conversation is how a nudge lands
    // in the one he is not reading.
    expect(() => registerSender(h)).toThrow(/already registered/);
  });

  test('the push lands the daemon\'s composed sentence verbatim', async () => {
    const outcome = await h.invoke('occasions.sweep') as {
      hold: string | null;
      nudge: { message: string } | null;
      deliveries: readonly { channel: string; delivered: boolean; failure: string | null }[];
    };
    expect(outcome.hold).toBeNull();
    expect(outcome.nudge).not.toBeNull();
    pushedMessage = outcome.nudge!.message;

    const agentDelivery = outcome.deliveries.find((entry) => entry.channel === 'agent');
    expect(agentDelivery?.delivered).toBe(true);
    expect(agentDelivery?.failure).toBeNull();

    // Platform runtime 2.0.9: the push arrives as a FRAMED, self-contained
    // notice, named as an occasion reminder, carrying the daemon's composed
    // sentence whole, never a bare line woven into other conversation.
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toContain('[Occasion reminder]');
    expect(h.said[0]).toContain(pushedMessage);
    expect(h.said[0]).toContain('Sarah');
    // Proximity is a word: no date and no day count reached the transcript (§4.3).
    expect(/\d/.test(h.said[0] ?? '')).toBe(false);
  });

  test('and the pull then says nothing about it: one thing said once', async () => {
    const outstanding = await h.invoke('occasions.pending') as { nudge: { message: string } | null };
    // The item is stamped, the agent is a configured push destination, so the pull
    // leaves it out. He was told once.
    expect(outstanding.nudge).toBeNull();
    // And nothing else reached the transcript behind the pull's back, still
    // exactly the one framed notice.
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toContain(pushedMessage);
  });

  test('the answer and interview loop is reached the same way after a push as after a pull', async () => {
    // The loop does not know or care which path raised the nudge: both raise the
    // SAME open item, and an answer resolves it from either side.
    const list = await h.invoke('occasions.list') as { occasions: readonly { occasion: { id: string } }[] };
    const occasionId = list.occasions[0]?.occasion.id;
    expect(occasionId).toBeTruthy();

    const answered = await h.invoke('occasions.answer', { occasionId, answer: 'yes' }) as {
      ok: boolean;
      interview: { interviewId: string; nextStep: { id: string; prompt: string } | null } | null;
    };
    expect(answered.ok).toBe(true);
    // A yes on a gift-giving occasion opens the short interview (§4.10).
    expect(answered.interview).not.toBeNull();
    expect(answered.interview?.nextStep?.prompt).toBeTruthy();

    // One step round-trips through the same verbs the `occasions` tool relays.
    const step = answered.interview!.nextStep!;
    const progressed = await h.invoke('occasions.interview.answer', {
      interviewId: answered.interview!.interviewId,
      stepId: step.id,
      text: 'she keeps mentioning pottery',
    }) as { present: boolean; interview: { interviewId: string } | null };
    expect(progressed.present).toBe(true);
    expect(progressed.interview?.interviewId).toBe(answered.interview!.interviewId);
  });

  test('the undo releases the destination, which is the shutdown path bootstrap wires', () => {
    undo?.();
    expect(h.services.channelDeliveryRouter.agentDelivery.registered).toBe(false);
  });
});

describe('no sender registered: the push is refused BY NAME and the pull still raises', () => {
  const h = harness();

  test('the sweep records the SDK\'s named failure and lands nothing', async () => {
    expect(h.services.channelDeliveryRouter.agentDelivery.registered).toBe(false);

    const outcome = await h.invoke('occasions.sweep') as {
      hold: string | null;
      nudge: { message: string } | null;
      delivered: boolean;
      deliveries: readonly { channel: string; delivered: boolean; failure: string | null }[];
    };
    expect(outcome.hold).toBeNull();
    expect(outcome.nudge).not.toBeNull();
    expect(outcome.delivered).toBe(false);

    const agentDelivery = outcome.deliveries.find((entry) => entry.channel === 'agent');
    expect(agentDelivery?.delivered).toBe(false);
    // Named at the registration, not a generic "unsupported target" that would
    // send a reader looking for a missing surface kind.
    expect(agentDelivery?.failure).toContain('No agent conversation sender is registered');
    expect(agentDelivery?.failure).toContain('agentDelivery.register()');
    // Recorded, not thrown: the sweep completed and reported.
    expect(h.said).toEqual([]);
  });

  test('the pull STILL raises it, because nothing landed to stamp the item', async () => {
    // The case the stamp must not cover. A guard keyed on the CONFIGURED
    // destination rather than the LANDED push would have silenced this, and he
    // would simply never hear about the birthday.
    const outstanding = await h.invoke('occasions.pending') as { nudge: { message: string } | null };
    expect(outstanding.nudge).not.toBeNull();
    expect(outstanding.nudge?.message).toContain('Sarah');
    expect(/\d/.test(outstanding.nudge?.message ?? '')).toBe(false);
  });

  test('a direct push to the agent surface reports the same named error to its caller', async () => {
    const outcome = await h.services.channelDeliveryRouter.deliver({
      target: { kind: 'surface', surfaceKind: 'agent' },
      body: 'anything',
      title: 'anything',
      jobId: 'test',
      runId: 'test-1',
      includeLinks: false,
    }).then(() => 'delivered').catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    // A crash would be a stack trace in a log; this is a sentence naming what to do.
    expect(outcome).toContain('No agent conversation sender is registered');
  });
});

describe('sender registered but unable to land: this repo\'s own throw keeps the pull alive', () => {
  const h = harness();

  test('a sender with no conversation refuses, and the sweep records ITS reason', async () => {
    // The previous block covers the SDK's refusal (nothing registered). This one
    // covers OURS: registered, called, and unable to land. It is the case where
    // this repo's code decides whether the nudge survives.
    h.services.channelDeliveryRouter.agentDelivery.register(
      createAgentConversationSender({
        primaryConversation: () => null,
        requestRender: () => undefined,
      }),
    );

    const outcome = await h.invoke('occasions.sweep') as {
      nudge: { message: string } | null;
      delivered: boolean;
      deliveries: readonly { channel: string; delivered: boolean; failure: string | null }[];
    };
    expect(outcome.nudge).not.toBeNull();
    expect(outcome.delivered).toBe(false);
    const agentDelivery = outcome.deliveries.find((entry) => entry.channel === 'agent');
    expect(agentDelivery?.delivered).toBe(false);
    expect(agentDelivery?.failure).toContain('no active conversation');
    expect(h.said).toEqual([]);
  });

  test('the pull STILL raises it, because our throw left the item unstamped', async () => {
    // This is what the throw buys. Swallowing the failure and returning an id
    // would report a delivery that never happened, the daemon would stamp the
    // item, and the pull would go quiet about a nudge that reached nobody. That
    // is the one outcome this feature cannot have, and it is why the sender
    // throws rather than logging and moving on.
    const outstanding = await h.invoke('occasions.pending') as { nudge: { message: string } | null };
    expect(outstanding.nudge).not.toBeNull();
    expect(outstanding.nudge?.message).toContain('Sarah');
  });
});
