/**
 * The verb-family oracle, at the process that serves the verbs.
 *
 * ── Why this file is here and not in the agent ────────────────────────────
 *
 * This sweep used to live in goodvibes-agent
 * (src/test/daemon/gateway-parity-verb-families.test.ts). That package composes
 * no server and registers no gateway handler, so the suite could not drive its
 * own catalog; it built a SECOND catalog from a test-only helper
 * (src/test/helpers/daemon-gateway.ts) that re-passed, by hand, the dependency
 * list this daemon's composition root passes for real. What it verified was
 * that a reconstruction of the composition answers, not that the composition
 * does. The two can disagree the moment service-graph.ts drops a dep the helper
 * still lists, which is the exact regression the sweep exists to catch.
 *
 * Here the catalog under test is `createRuntimeServices(...).gatewayMethods`:
 * the object this daemon hands to DaemonServer and answers every surface from.
 * No reconstruction, no second dependency list.
 *
 * ── What it asserts ──────────────────────────────────────────────────────
 *
 * Every gateway verb family this composition serves is (a) cataloged and (b)
 * HANDLER-ATTACHED. A descriptor with no handler answers 501 "Gateway method is
 * not invokable" over both websocket and HTTP invoke, so a whole family can
 * look present in the contract and be dead, the regression class
 * gateway-ws-only-invokable.test.ts's header documents, found in the field
 * against a shipped build.
 *
 * The table below is the single source of truth for "does family X register
 * live here". Two properties make it one rather than a sample:
 *
 *   1. Every family carries the REASON it registers, read from the SDK's
 *      register-gateway-verb-groups.ts and this repo's service-graph.ts, not
 *      inferred. A family is either always registered (built internally from
 *      shellPaths/config) or gated on a dep this composition threads. When a
 *      future SDK bump stops wiring one, the failure names the dep.
 *   2. `no handler-attached verb in this composition is missing from this
 *      table` sweeps the other direction: a verb that gains a handler here and
 *      is named nowhere fails, so a new family arrives with a stated reason
 *      instead of arriving unnoticed.
 *
 * Deeper functional round-trips live in their own files and are deliberately
 * not duplicated here:
 *   - gateway-ws-only-invokable.test.ts, fleet.*, checkpoints.* core,
 *     sessions.search, push.*, permissions.rules.*
 *   - gateway-initiative-verbs.test.ts, checkin.*, ci.*, principals.*,
 *     channels.profiles.*
 *   - gateway-occasions-verbs.test.ts, occasions.*
 *   - gateway-checkin-round-trip.test.ts, the check-in loop end to end
 *   - gateway-ci-principals-channel-profiles-round-trip.test.ts, those three
 *     families end to end
 *   - gateway-device-capability-verbs.test.ts, devices.*
 *   - gateway-rewind-conversation-scope.test.ts, the conversation half of
 *     rewind.*
 *   - gateway-catalog-handler-or-route.test.ts, the whole-catalog partition:
 *     every descriptor is handler-attached, route-served, or declared
 *     uncallable.
 */
import { describe, expect, test } from 'bun:test';
import { assertEveryDescriptorHasHandler } from '@goodvibes-jev/engine/terminal-shell/conformance';
import { useGatewayFixture } from '../helpers/gateway-route-fixture.js';
const fixture = useGatewayFixture({ hostSessions: false });

// Stop the shared test runtime graph when this file ends, see that helper's doc.


interface VerbFamily {
  readonly family: string;
  readonly reason: string;
  readonly methodIds: readonly string[];
}

/**
 * Every verb family this composition attaches a handler for, grouped by family
 * (not flattened) so a single missing method id inside an otherwise-live family
 * is still legible in the failure.
 */
const VERB_FAMILIES: readonly VerbFamily[] = [
  {
    family: 'contracts.*',
    reason: 'The actual service graph constructs createDaemonContractServices and threads its runner/operator into gateway registration.',
    methodIds: ['contracts.cancel', 'contracts.get', 'contracts.list', 'contracts.reply', 'contracts.start'],
  },
  {
    family: 'workLedger.*',
    reason: 'The actual graph registers native work-ledger methods, execution, submission and intake services, plus legacy import over the composed stores.',
    methodIds: ['workLedger.execution.cancel', 'workLedger.execution.resume', 'workLedger.execution.start', 'workLedger.execution.status',
      'workLedger.history', 'workLedger.importLegacy', 'workLedger.intake.admit', 'workLedger.intake.cancel', 'workLedger.intake.capture',
      'workLedger.intake.get', 'workLedger.intake.resume', 'workLedger.prepareLegacyImport', 'workLedger.project', 'workLedger.snapshot',
      'workLedger.submission.get', 'workLedger.submit'],
  },
  {
    family: 'inbound.telegram.*',
    reason: 'DaemonServer composes the owned delegated Telegram intake host and registers its commands in facade-delegated-telegram.ts.',
    methodIds: ['inbound.telegram.cancel', 'inbound.telegram.configure', 'inbound.telegram.decide', 'inbound.telegram.list',
      'inbound.telegram.read', 'inbound.telegram.revoke', 'inbound.telegram.status'],
  },
  {
    family: 'relay.*',
    reason: 'DaemonServer registers relay gateway methods over its own reachability state in facade.ts.',
    methodIds: ['relay.pairing.mint', 'relay.reachability.get'],
  },
  {
    family: 'sessions.turns.cancel',
    reason: 'registerSessionRuntimeGatewayMethods attaches cancellation over the sessionLiveTurnControls threaded by the service graph.',
    methodIds: ['sessions.turns.cancel'],
  },
  {
    family: 'update.*',
    reason: 'DaemonServer registers status/check lifecycle handlers, including honest refusal while its update host is unarmed.',
    methodIds: ['update.check', 'update.status'],
  },
  // ── Families this daemon serves for itself ────────────────────────────────
  {
    family: 'fleet.* (snapshot / list / archive lifecycle)',
    reason: 'Always registered by registerFleetCheckpointsSearchGatewayMethods over the process registry this composition builds.',
    methodIds: [
      'fleet.snapshot', 'fleet.list', 'fleet.archive', 'fleet.unarchive',
      'fleet.archiveFinished', 'fleet.archived.list', 'fleet.observed.steer',
    ],
  },
  {
    family: 'fleet.attempts.* / fleet.graph.get',
    reason: 'Registered because attemptsController (the orchestration engine) is threaded in service-graph.ts.',
    methodIds: ['fleet.attempts.list', 'fleet.attempts.pick', 'fleet.attempts.judge', 'fleet.graph.get'],
  },
  {
    family: 'fleet.conflicts.*',
    reason: 'Registered only when the attempts engine exposes listWorkstreams/stampConflictSession/retryItemIntegration AND automationManager is present; both are threaded here (register-gateway-verb-groups.ts, the conflict block).',
    methodIds: ['fleet.conflicts.list', 'fleet.conflicts.resolve'],
  },
  {
    family: 'checkpoints.* (list / create / diff / restore + previews and hunk revert)',
    reason: 'Registered over the registration-gated CheckpointsGatewayManager service-graph.ts threads as workspaceCheckpointManager, so an explicit create in an unregistered workspace refuses with something actionable.',
    methodIds: [
      'checkpoints.list', 'checkpoints.create', 'checkpoints.diff', 'checkpoints.restore',
      'checkpoints.restorePreview', 'checkpoints.revertHunkPreview', 'checkpoints.revertHunk',
    ],
  },
  {
    family: 'sessions.search / sessions.changes.get',
    reason: 'Registered over the same fleet/checkpoints group; sessionChanges reads the CheckpointsGatewayManager already threaded.',
    methodIds: ['sessions.search', 'sessions.changes.get'],
  },
  {
    family: 'push.*',
    reason: 'Always registered: the SDK builds the push subscription service internally from shellPaths and config.',
    methodIds: [
      'push.vapid.get', 'push.subscriptions.list', 'push.subscriptions.create',
      'push.subscriptions.delete', 'push.subscriptions.verify', 'push.subscriptions.reconcile',
    ],
  },
  {
    family: 'permissions.rules.*',
    reason: 'Registered because userPermissionRuleStore is threaded in service-graph.ts (durable remembered-approval rules; the same store feeds the brokered permission manager). Read/delete only by design: rules are written by remembered approval decisions, never by a verb.',
    methodIds: ['permissions.rules.list', 'permissions.rules.delete'],
  },
  {
    family: 'workspaces.registrations.* / workspaces.resolve',
    reason: 'Always registered: the SDK constructs the shared WorkspaceRegistrationStore internally from shellPaths.',
    methodIds: [
      'workspaces.registrations.list', 'workspaces.registrations.add',
      'workspaces.registrations.remove', 'workspaces.resolve',
    ],
  },
  {
    family: 'rewind.plan / rewind.apply',
    reason: 'Always registered (files-only rewind over the workspace checkpoint manager already threaded). The conversation scope is a separate honesty concern; see gateway-rewind-conversation-scope.test.ts.',
    methodIds: ['rewind.plan', 'rewind.apply'],
  },
  {
    family: 'rewind.conversation.* (host registry)',
    reason: 'Always registered: the host registry that lets a client hold the mutable conversation and answer this daemon\'s rewind requests is built internally.',
    methodIds: [
      'rewind.conversation.host.register', 'rewind.conversation.host.release',
      'rewind.conversation.hosts.list', 'rewind.conversation.requests.take',
      'rewind.conversation.requests.answer',
    ],
  },
  {
    family: 'skills.*',
    reason: 'Always registered: the SDK constructs a FileSystemSkillStore-backed SkillService internally from shellPaths.',
    methodIds: ['skills.list', 'skills.get', 'skills.create', 'skills.update', 'skills.delete'],
  },
  {
    family: 'principals.*',
    reason: 'Always registered: the SDK constructs the PrincipalRegistry internally from shellPaths. Deeper round-trip: gateway-ci-principals-channel-profiles-round-trip.test.ts.',
    methodIds: [
      'principals.list', 'principals.get', 'principals.create',
      'principals.update', 'principals.delete', 'principals.resolve',
    ],
  },
  {
    family: 'channels.profiles.*',
    reason: 'Always registered: the SDK constructs the ChannelProfileRegistry internally from shellPaths. Deeper round-trip: gateway-ci-principals-channel-profiles-round-trip.test.ts.',
    methodIds: [
      'channels.profiles.list', 'channels.profiles.get',
      'channels.profiles.set', 'channels.profiles.delete',
    ],
  },
  {
    family: 'channels.test.send',
    reason: 'Registered because channelDeliveryRouter is threaded in service-graph.ts.',
    methodIds: ['channels.test.send'],
  },
  {
    family: 'checkin.*',
    reason: 'Registered because channelDeliveryRouter, providerRegistry, automationManager and sessionLister are ALL threaded in service-graph.ts. Deeper round-trip: gateway-checkin-round-trip.test.ts.',
    methodIds: ['checkin.config.get', 'checkin.config.set', 'checkin.run', 'checkin.receipts.list'],
  },
  {
    family: 'ci.*',
    reason: 'Always registered (the gh-CLI source and the watch store need no dep); the notifier and fix-session enrich when channelDeliveryRouter/automationManager are present, and both are here. Deeper round-trip: gateway-ci-principals-channel-profiles-round-trip.test.ts.',
    methodIds: ['ci.status', 'ci.watches.create', 'ci.watches.list', 'ci.watches.delete', 'ci.watches.run'],
  },
  {
    family: 'worktrees.setup.run / worktrees.discard',
    reason: 'Registered because workingDirectory is threaded in service-graph.ts. This was the one wiring gap the sweep that first wrote this table found: the dep was in scope at the composition root and was not being passed, so the family was cataloged and dead.',
    methodIds: ['worktrees.setup.run', 'worktrees.discard'],
  },
  {
    family: 'flags.graduation.report',
    reason: 'Always registered: reads the static flag registry plus graduation annotations, no runtime dependency.',
    methodIds: ['flags.graduation.report'],
  },
  {
    family: 'cost.attribution.get / quota.*',
    reason: 'Always registered: CostAttributionService and QuotaWindowTracker are constructed internally; ingestion is enriched when providerRegistry/runtimeBus are present (both are here) but the verbs register regardless.',
    methodIds: ['cost.attribution.get', 'quota.fanout.get', 'quota.snapshot.get'],
  },
  {
    family: 'sessions.permissionMode.* / sessions.contextUsage.get',
    reason: "Always registered: the SDK's createSessionRuntimeControls is built internally from configManager plus runtimeStore, both always present in this composition.",
    methodIds: ['sessions.permissionMode.get', 'sessions.permissionMode.set', 'sessions.contextUsage.get'],
  },
  {
    family: 'sessions.toolCalls.cancel / sessions.queuedMessages.*',
    reason: 'Always registered by the same session-runtime group; the sessionLiveTurnControls holder threaded here is what makes the verbs act on the live turn instead of refusing LIVE_TURN_CONTROLS_UNAVAILABLE.',
    methodIds: [
      'sessions.toolCalls.cancel', 'sessions.queuedMessages.list',
      'sessions.queuedMessages.edit', 'sessions.queuedMessages.delete',
    ],
  },
  {
    family: 'profile.*',
    reason: "Always registered: the SDK's composeOwnerProfile builds the OwnerProfileStore internally from configManager plus the resolved daemon home. One Markdown file at daemon scope, and this is the process that owns it.",
    methodIds: [
      'profile.read', 'profile.get', 'profile.person', 'profile.provenance',
      'profile.set', 'profile.append', 'profile.forget', 'profile.undo', 'profile.status',
    ],
  },
  {
    family: 'occasions.*',
    reason: "Always registered: installOccasions runs INSIDE composeOwnerProfile over the same store, with the machine-owned state file resolved from shellPaths. Deeper round-trip: gateway-occasions-verbs.test.ts.",
    methodIds: [
      'occasions.list', 'occasions.pending', 'occasions.state', 'occasions.sweep',
      'occasions.propose', 'occasions.confirm', 'occasions.remove', 'occasions.answer', 'occasions.acknowledge',
      'occasions.interview.get', 'occasions.interview.answer', 'occasions.interview.record',
      'occasions.gifts', 'occasions.conflict.resolve',
      'occasions.plans.list', 'occasions.plans.propose', 'occasions.plans.confirm',
    ],
  },
  {
    family: 'power.status.get / power.keepAwake.set',
    reason: 'Registered because powerManager is threaded in service-graph.ts (sleep ownership, keep-awake toggle).',
    methodIds: ['power.status.get', 'power.keepAwake.set'],
  },
  {
    family: 'acp.agents.list / acp.sessions.create',
    reason: 'Registered because acpHost (an AcpHostService constructed in service-graph.ts, wired to the shared approval broker and session broker) is threaded into the gateway verb group registration. Deeper round-trip: gateway-acp-verbs.test.ts.',
    methodIds: ['acp.agents.list', 'acp.sessions.create'],
  },

  // ── Families the agent's sweep never covered, because the agent never
  //    threaded their deps. They are this daemon's, and they were unpinned. ──
  {
    family: 'approvals.raise',
    reason: 'Registered because approvalRaise is threaded in service-graph.ts. This is a surface CREATING an ask in this broker: without it the verb is cataloged and unhandled, and a client whose prompt runs outside this process has no way to raise one. Absent from every conformance list before this file.',
    methodIds: ['approvals.raise'],
  },
  {
    family: 'credentials.set / credentials.delete',
    reason: 'Registered because credentialWrites ({ config, secrets }) is threaded in service-graph.ts. A credential written THROUGH the control plane, so a client with no access to the daemon settings file can configure one; the value lands in the daemon secret tier and the verb never echoes it back. Absent from every conformance list before this file.',
    methodIds: ['credentials.set', 'credentials.delete'],
  },
  {
    family: 'devices.*',
    reason: 'Registered because deviceCapabilities is threaded from this repo\'s device-posture composition. Deeper round-trip: gateway-device-capability-verbs.test.ts; per-key governance: ../runtime/device-posture-key-governance.test.ts.',
    methodIds: [
      'devices.nodes.list', 'devices.capability.request', 'devices.artifacts.list',
      'devices.artifacts.read', 'devices.grants.list', 'devices.grants.revoke',
      'devices.housekeeping.run',
    ],
  },
  {
    family: 'ops.memory.get',
    reason: 'Registered because memoryGovernor is threaded in service-graph.ts.',
    methodIds: ['ops.memory.get'],
  },
  {
    family: 'memory.projections.*',
    reason: 'Registered because memoryRegistry is threaded in service-graph.ts.',
    methodIds: ['memory.projections.list', 'memory.projections.get'],
  },
  {
    family: 'voice.local.* / voice.wake.*',
    reason: 'Registered because voiceSetup is threaded in service-graph.ts (wireVoiceSetup: managed one-act local-voice provisioning and the wake-word model).',
    methodIds: [
      'voice.local.status', 'voice.local.install',
      'voice.wake.status', 'voice.wake.provision', 'voice.wake.model.get',
    ],
  },
  {
    family: 'pairing.tokens.* / pairing.posture.get',
    reason: 'Registered because pairingTokens is threaded in service-graph.ts.',
    methodIds: [
      'pairing.tokens.list', 'pairing.tokens.create', 'pairing.tokens.delete',
      'pairing.tokens.rename', 'pairing.tokens.migrate', 'pairing.tokens.revokeShared',
      'pairing.posture.get',
    ],
  },
  {
    family: 'pairing.handoff.*',
    reason: 'Registered alongside the pairing tokens group, over the relay-availability and pairing-origin readers service-graph.ts threads (relayAvailable / pairingWebOrigin).',
    methodIds: ['pairing.handoff.create', 'pairing.handoff.complete'],
  },
  {
    family: 'stepup.*',
    reason: 'Registered because stepUpService is threaded in service-graph.ts (the relay step-up ceremony).',
    methodIds: ['stepup.challenge.mint', 'stepup.credentials.register'],
  },
  {
    family: 'tailscale.get / tailscale.serve.run',
    reason: 'Always registered: built internally from configManager and shellPaths.',
    methodIds: ['tailscale.get', 'tailscale.serve.run'],
  },
  {
    family: 'runtime.metrics.get',
    reason: 'Always registered: reads process-local runtime metrics, no dependency.',
    methodIds: ['runtime.metrics.get'],
  },
  {
    family: 'calendar.*',
    reason: 'Registered because composeMailDeps in service-graph.ts builds a calendar gateway from configManager plus secretsManager. Platform-served: the terminal app calls these across the wire.',
    methodIds: [
      'calendar.events.list', 'calendar.events.get', 'calendar.events.create',
      'calendar.ics.import', 'calendar.ics.export',
    ],
  },
  {
    family: 'email.*',
    reason: 'Registered because composeMailDeps in service-graph.ts supplies emailServiceDeps and describeEmailConfigProblem. Same reason as calendar.*: this is the process that holds the mailbox credentials.',
    methodIds: ['email.inbox.list', 'email.inbox.read', 'email.draft.create', 'email.send'],
  },
  {
    family: 'browser.*',
    reason: 'Registered because the SDK builds a browser gateway for this composition; the disposal scope service-graph.ts threads is what shuts the sessions down.',
    methodIds: [
      'browser.provision', 'browser.status', 'browser.snapshot', 'browser.navigate',
      'browser.click', 'browser.type', 'browser.press', 'browser.select', 'browser.scroll',
      'browser.extract', 'browser.readText', 'browser.screenshot', 'browser.waitFor',
      'browser.history.back', 'browser.history.forward',
      'browser.sessions.launch', 'browser.sessions.attach', 'browser.sessions.list',
      'browser.sessions.close', 'browser.sessions.release',
      'browser.tabs.create', 'browser.tabs.list', 'browser.tabs.switch', 'browser.tabs.close',
    ],
  },

  // ── This repository's OWN handler surfaces, attached by
  //    runtime/daemon-handler-composition.ts rather than by the SDK. ─────────
  {
    family: 'channels.routing.*',
    reason: "This repo's own handler surface (daemon/handlers/routing), attached over the SDK's canonical descriptors by daemon-handler-composition.ts.",
    methodIds: ['channels.routing.list', 'channels.routing.assign', 'channels.routing.delete'],
  },
  {
    family: 'channels.inbox.list',
    reason: "This repo's own inbox surface (daemon/handlers/inbox), wrapped by the triage pipeline (daemon/handlers/triage) so every returned item carries its score. It answers for real now rather than only registering: the SDK descriptor carried `invokable: false` until this daemon's aggregator served it, so the handler counted here was one no client could reach. Behaviour lives in daemon/inbox/aggregator.test.ts, reachability over both transports in gateway-inbox-list-reachable.test.ts.",
    methodIds: ['channels.inbox.list'],
  },
  {
    family: 'channels.drafts.*',
    reason: "This repo's own draft store (daemon/handlers/drafts), server-side so a draft survives the surface that wrote it.",
    methodIds: ['channels.drafts.list', 'channels.drafts.get', 'channels.drafts.save', 'channels.drafts.delete'],
  },
  {
    family: 'payments.* (budget / cards / purchases / checkout)',
    reason:
      "This repo's own payments surface (daemon/handlers/payments), composed by runtime/payments-composition.ts. "
      + 'budget.status/cards.list/cards.delete attach through the SDK\'s own registerPaymentsGatewayMethods '
      + '(published from control-plane/index.ts since sdk 2.0.18); cards.create/purchases.list keep local '
      + 'wrappers for field-shape validation the SDK route does not do (see register.ts). checkout.begin/'
      + 'checkout.fillCard attach through local wrappers too, over the sdk 2.0.19 browser-checkout seam '
      + '(composeDaemonBrowser/onBrowserCheckout/BrowserCheckoutSeam), because context.explicitUserRequest, '
      + "the signal this daemon's owner-approval ruling needs, only reaches a handler attached this way; see "
      + 'register.ts\'s header and gateway-payments-verbs.test.ts, which exercises the ruling over real routes. '
      + 'checkout.approve is the one PRODUCT-authored descriptor in the family (register.ts\'s '
      + 'CHECKOUT_APPROVE_DESCRIPTOR): the id is this daemon\'s own, ws-only with no REST binding since the '
      + 'gateway REST table is the daemon-sdk\'s, and it mints the persisted single-use approval record '
      + 'checkout.begin spends (daemon/handlers/payments/approval-store.ts).',
    methodIds: [
      'payments.budget.status',
      'payments.cards.list', 'payments.cards.create', 'payments.cards.delete',
      'payments.purchases.list',
      'payments.checkout.approve', 'payments.checkout.begin', 'payments.checkout.fillCard',
    ],
  },
];

const ALL_METHOD_IDS: readonly string[] = VERB_FAMILIES.flatMap((entry) => entry.methodIds);

describe('gateway verb family parity, over this daemon\'s own composition', () => {
  const services = () => fixture().services;

  for (const { family, reason, methodIds } of VERB_FAMILIES) {
    test(`${family}: every descriptor is registered on the catalog (${reason})`, () => {
      for (const methodId of methodIds) {
        expect(
          services().gatewayMethods.get(methodId),
          `${methodId} descriptor missing from the composed catalog`,
        ).toBeTruthy();
      }
    });
  }

  test('every pinned descriptor across all families has an attached handler (shipped conformance gate)', () => {
    expect(() =>
      assertEveryDescriptorHasHandler(services().gatewayMethods, { onlyIds: ALL_METHOD_IDS }),
    ).not.toThrow();
  });

  test('no family in this pinned list is silently missing from the catalog entirely', () => {
    // The conformance helper sweeps handlers over descriptors already
    // registered, so an id absent from the catalog would be silently skipped.
    const missing = ALL_METHOD_IDS.filter((id) => !services().gatewayMethods.get(id));
    expect(missing).toEqual([]);
  });

  test('the table has no duplicate ids, so a family count is a real count', () => {
    const seen = new Set<string>();
    const duplicated = ALL_METHOD_IDS.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicated).toEqual([]);
  });

  test('no handler-attached verb in this composition is missing from this table', () => {
    // The other direction, and the half that makes this file a source of truth
    // rather than a sample: a verb that gains a handler here and is named
    // nowhere arrives with no stated reason and nothing watching it.
    const pinned = new Set(ALL_METHOD_IDS);
    const unpinned = services().gatewayMethods
      .list()
      .map((descriptor) => descriptor.id)
      .filter((id) => services().gatewayMethods.hasHandler(id))
      .filter((id) => !pinned.has(id))
      .sort();
    expect(
      unpinned,
      'These verbs have a handler on this daemon\'s composed catalog and appear in no family above. '
      + 'Add each to VERB_FAMILIES with the reason it registers (read it from '
      + 'register-gateway-verb-groups.ts or runtime/service-graph.ts, do not infer it).',
    ).toEqual([]);
  });
});
