/**
 * assert-contract-shape.test.ts, proves the e2e fixtures actually conform to
 * the SDK's operator-contract.json, and proves the assertion is not a rubber stamp: a
 * deliberately-drifted fixture (a renamed/dropped required field, exactly the shape of
 * the provider-pills incident this closes, see seed.ts's providersResponse() header)
 * must FAIL it.
 *
 * Runs under `bun test` (a plain *.test.ts file, not a Playwright *.e2e.ts spec, see
 * playwright.config.ts's testMatch), and never touches a Page or a port: every sample
 * here comes straight from the exported, pure fixture builders in seed.ts /
 * mock-daemon.ts, the same functions installMockDaemon wires into its `page.route`
 * interceptor.
 */
import { describe, expect, test } from 'bun:test';
import { assertFixtureMatchesOperatorContract, ContractShapeError } from './assert-contract-shape';
import {
  CLOSED_SESSION,
  FLEET_SNAPSHOT,
  FOLLOWUP_SESSION,
  messagesResponse,
  providersResponse,
  STEERABLE_SESSION,
  unionListResponse,
} from './seed';
import {
  dispatchOutcome,
  fleetGraphResponse,
  FLEET_GRAPH_WORKSTREAM_ID,
  methodInfoResponse,
  opsMemoryResponse,
  powerStatusResponse,
  voiceLocalInstallResponse,
  voiceLocalStatusInProgressResponse,
  voiceLocalStatusResponse,
} from './mock-daemon';

describe('e2e fixtures conform to the SDK operator contract', () => {
  test('providers.list: providersResponse() conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('providers.list', providersResponse())).not.toThrow();
  });

  test('providers.get: every seeded provider conforms individually', () => {
    for (const provider of providersResponse().providers) {
      expect(() => assertFixtureMatchesOperatorContract('providers.get', provider)).not.toThrow();
    }
  });

  test('sessions.list: unionListResponse() (GET /api/sessions) conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.list', unionListResponse())).not.toThrow();
  });

  test('sessions.get / sessions.messages.list: messagesResponse() conforms for every seeded session', () => {
    for (const session of [STEERABLE_SESSION, FOLLOWUP_SESSION, CLOSED_SESSION]) {
      const response = messagesResponse(session.id);
      expect(() => assertFixtureMatchesOperatorContract('sessions.get', response)).not.toThrow();
      expect(() => assertFixtureMatchesOperatorContract('sessions.messages.list', response)).not.toThrow();
    }
  });

  test('sessions.messages.list: the "unknown session id" fallback still conforms', () => {
    const response = messagesResponse('no-such-session');
    expect(() => assertFixtureMatchesOperatorContract('sessions.messages.list', response)).not.toThrow();
  });

  test('sessions.steer: dispatchOutcome() conforms for a steerable (agent-bound) session', () => {
    const outcome = dispatchOutcome(STEERABLE_SESSION, 'steer', 'keep going', 'in-1');
    expect(() => assertFixtureMatchesOperatorContract('sessions.steer', outcome)).not.toThrow();
  });

  test('sessions.followUp: dispatchOutcome() conforms for a closed-agent session', () => {
    const outcome = dispatchOutcome(FOLLOWUP_SESSION, 'follow-up', 'do this next', 'fu-1');
    expect(() => assertFixtureMatchesOperatorContract('sessions.followUp', outcome)).not.toThrow();
  });

  test('sessions.steer / sessions.followUp: dispatchOutcome() conforms even for an unknown session (session: null)', () => {
    const steerOutcome = dispatchOutcome(undefined, 'steer', 'x', 'in-99');
    const followUpOutcome = dispatchOutcome(undefined, 'follow-up', 'x', 'fu-99');
    expect(() => assertFixtureMatchesOperatorContract('sessions.steer', steerOutcome)).not.toThrow();
    expect(() => assertFixtureMatchesOperatorContract('sessions.followUp', followUpOutcome)).not.toThrow();
  });

  test('control.methods.get: methodInfoResponse() conforms (the sessions.delete capability probe)', () => {
    expect(() => assertFixtureMatchesOperatorContract('control.methods.get', methodInfoResponse('sessions.delete'))).not.toThrow();
  });

  test('fleet.graph.get: fleetGraphResponse() conforms; proves every node state tell (ready/running/blocked/stalled/done) and the at-cap pool state against the real contract', () => {
    expect(() => assertFixtureMatchesOperatorContract('fleet.graph.get', fleetGraphResponse(FLEET_GRAPH_WORKSTREAM_ID))).not.toThrow();
  });

  test('power.status.get / power.keepAwake.set: powerStatusResponse() conforms, the held, honest lid-split case', () => {
    expect(() => assertFixtureMatchesOperatorContract('power.status.get', powerStatusResponse())).not.toThrow();
    expect(() => assertFixtureMatchesOperatorContract('power.keepAwake.set', powerStatusResponse())).not.toThrow();
  });

  test('ops.memory.get: opsMemoryResponse() conforms, the elevated tier with caches, a paused job, and tripwire state', () => {
    expect(() => assertFixtureMatchesOperatorContract('ops.memory.get', opsMemoryResponse())).not.toThrow();
  });

  test('voice.local.status: voiceLocalStatusResponse() conforms. The size-labeled not-provisioned offer', () => {
    expect(() => assertFixtureMatchesOperatorContract('voice.local.status', voiceLocalStatusResponse())).not.toThrow();
  });

  test('voice.local.status: the in-progress variant conforms, the optional installInProgress section of an active install', () => {
    expect(() => assertFixtureMatchesOperatorContract('voice.local.status', voiceLocalStatusInProgressResponse())).not.toThrow();
  });

  test('voice.local.install: both receipt outcomes conform (provisioned, retriable download failure)', () => {
    expect(() => assertFixtureMatchesOperatorContract('voice.local.install', voiceLocalInstallResponse('provisioned'))).not.toThrow();
    expect(() => assertFixtureMatchesOperatorContract('voice.local.install', voiceLocalInstallResponse('download-failed'))).not.toThrow();
  });

  // sessions.permissionMode.get/set + sessions.contextUsage.get (SDK 1.6.1), the mock
  // daemon's own answer shapes for the local-session-only verbs, pinned against the
  // real installed contract the same way every other fixture above is.
  test('sessions.permissionMode.get: the mock daemon\'s response shape conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.permissionMode.get', { sessionId: 's-agent-live', mode: 'normal' })).not.toThrow();
  });

  test('sessions.permissionMode.set: the mock daemon\'s response shape conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.permissionMode.set', { sessionId: 's-agent-live', mode: 'auto', previousMode: 'normal' })).not.toThrow();
  });

  test('sessions.contextUsage.get: the mock daemon\'s response shape conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.contextUsage.get', {
      sessionId: 's-agent-live',
      estimatedContextTokens: 4200,
      contextWindow: 200000,
      contextUsagePct: 2,
      contextRemainingTokens: 195800,
      estimated: true,
    })).not.toThrow();
  });

  // sessions.changes.get + cost.attribution.get (SDK 1.6.1), the mock daemon's own
  // answer shapes for these two new generic-invoke verbs, pinned against the real
  // installed contract the same way every other fixture above is.
  test('sessions.changes.get: the mock daemon\'s honest-empty response shape conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.changes.get', {
      sessionId: 's-other', checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY',
      files: [], unifiedDiff: '', stat: '',
    })).not.toThrow();
  });

  test('sessions.changes.get: the mock daemon\'s stamped-checkpoint response shape conforms', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.changes.get', {
      sessionId: 's-agent-live', checkpointCount: 1, checkpointIds: ['wcp_e2e_1'], from: 'EMPTY', to: 'wcp_e2e_1',
      files: ['src/example.ts'],
      unifiedDiff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
      stat: '1 file changed',
    })).not.toThrow();
  });

  test('cost.attribution.get: the mock daemon\'s response shape conforms, provenance included', () => {
    const tokens = { inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 2000, cacheWriteTokens: 500 };
    // costSource + pricingAsOf on both the aggregate and the row: the wire's
    // pricing-provenance stamp, pinned against the real contract so a drift in
    // the source enum or the as-of field is caught here.
    expect(() => assertFixtureMatchesOperatorContract('cost.attribution.get', {
      window: '24h', windowStartMs: 1_700_000_000_000, dimension: 'session',
      totalCostUsd: 0.18, costState: 'estimated', pricedRecordCount: 4, unpricedRecordCount: 1,
      costSource: 'mixed', pricingAsOf: '2026-07-01T00:00:00.000Z',
      tokens,
      rows: [{
        key: 's-agent-live', costUsd: 0.18, costState: 'estimated', pricedRecordCount: 4, unpricedRecordCount: 1,
        costSource: 'catalog', pricingAsOf: '2026-07-01T00:00:00.000Z', tokens,
      }],
    })).not.toThrow();
  });

  test('fleet.snapshot: FLEET_SNAPSHOT conforms, including the derived needsAttention marker', () => {
    // FLEET_BLOCKED_NODE carries needsAttention: { reason:'input', detail }, the new
    // SDK field this consumer round adopts. This pins the fixture against the real
    // fleet.snapshot output schema so a drift in the attention shape is caught here.
    expect(() => assertFixtureMatchesOperatorContract('fleet.snapshot', FLEET_SNAPSHOT)).not.toThrow();
    const blocked = FLEET_SNAPSHOT.nodes.find((n) => n.id === 'agent-blocked-7');
    expect(blocked?.needsAttention).toEqual({ reason: 'input', detail: 'Which migration should I run?' });
  });
});

describe('assertFixtureMatchesOperatorContract actually catches drift', () => {
  test('a renamed top-level required field on providers.get FAILS', () => {
    const [provider] = providersResponse().providers;
    // Exactly the provider-pills incident's shape: inventing a field the wire schema
    // doesn't declare while dropping one it requires.
    const { modelCount: _modelCount, ...rest } = provider;
    const drifted = { ...rest, modelTotal: 1 };
    expect(() => assertFixtureMatchesOperatorContract('providers.get', drifted)).toThrow(ContractShapeError);
  });

  test('a dropped nested required field on providers.list (runtime.auth.mode) FAILS', () => {
    const response = providersResponse();
    const [first, ...remaining] = response.providers;
    const { mode: _mode, ...authRest } = first.runtime.auth;
    const drifted = {
      providers: [
        { ...first, runtime: { ...first.runtime, auth: authRest } },
        ...remaining,
      ],
    };
    expect(() => assertFixtureMatchesOperatorContract('providers.list', drifted)).toThrow(ContractShapeError);
  });

  test('a dropped top-level required field on sessions.steer\'s output (mode) FAILS', () => {
    const outcome = dispatchOutcome(STEERABLE_SESSION, 'steer', 'keep going', 'in-1');
    const { mode: _mode, ...drifted } = outcome;
    expect(() => assertFixtureMatchesOperatorContract('sessions.steer', drifted)).toThrow(ContractShapeError);
  });

  test('a dropped required field on a nested sessions.list array item (participants) FAILS', () => {
    const response = unionListResponse();
    const [first, ...remaining] = response.sessions;
    const { participants: _participants, ...drifted } = first;
    const withDrift = { ...response, sessions: [drifted, ...remaining] };
    expect(() => assertFixtureMatchesOperatorContract('sessions.list', withDrift)).toThrow(ContractShapeError);
  });

  test('binding to a method id the installed contract no longer declares FAILS', () => {
    expect(() => assertFixtureMatchesOperatorContract('sessions.doesNotExist', {})).toThrow(ContractShapeError);
  });
});
