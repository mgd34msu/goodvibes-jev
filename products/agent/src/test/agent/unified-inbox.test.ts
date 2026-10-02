import { describe, expect, test } from 'bun:test';
import { aggregateUnifiedInbox, formatUnifiedInbox } from '../../agent/unified-inbox.ts';
import type { AgentWorkspaceChannelTriage } from '../../input/agent-workspace-channel-triage.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriage(overrides: Partial<AgentWorkspaceChannelTriage> = {}): AgentWorkspaceChannelTriage {
  return {
    mode: 'channel_triage',
    status: 'ready',
    summary: 'test',
    readiness: {},
    deliveries: {
      route: '/api/deliveries',
      state: 'ready',
      totalAttempts: 0,
      attentionCount: 0,
      retryCandidateCount: 0,
      retryCandidates: [],
      attempts: [],
      totals: null,
    },
    surfaceMessages: {
      route: '/api/control-plane/messages',
      state: 'ready',
      totalMessages: 0,
      messages: [],
    },
    routeBindings: {
      route: '/api/routes/bindings',
      state: 'ready',
      totalBindings: 0,
      bindings: [],
    },
    receipts: {},
    inboundFeed: {},
    connectedHost: {},
    routes: {},
    policy: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateUnifiedInbox', () => {
  test('returns empty inbox when all sources are empty', () => {
    const inbox = aggregateUnifiedInbox(makeTriage());
    expect(inbox.mode).toBe('unified_inbox');
    expect(inbox.status).toBe('ready');
    expect(inbox.summary.totalItems).toBe(0);
    expect(inbox.summary.deliveryItems).toBe(0);
    expect(inbox.summary.surfaceMessageItems).toBe(0);
    expect(inbox.summary.routeBindingItems).toBe(0);
    expect(inbox.summary.attentionCount).toBe(0);
    expect(inbox.summary.failureCount).toBe(0);
    expect(inbox.items).toHaveLength(0);
    expect(inbox.inboundChannelFeed.available).toBe(false);
  });

  test('maps delivery attempt items to UnifiedInboxDeliveryItem', () => {
    const triage = makeTriage({
      deliveries: {
        route: '/api/deliveries',
        state: 'ready',
        totalAttempts: 1,
        attentionCount: 1,
        retryCandidateCount: 1,
        retryCandidates: [],
        attempts: [
          {
            id: 'del-1',
            runId: 'run-1',
            jobId: 'job-1',
            status: 'failed',
            target: { kind: 'surface', surfaceKind: 'slack', routeId: 'ops', label: 'Ops' },
            startedAt: 1000,
            endedAt: 2000,
            error: 'connection refused',
            inspectRoute: '/api/deliveries/del-1',
            modelRoute: 'autonomy action:"queue" query:"run-1"',
          },
        ],
        totals: null,
      },
    });
    const inbox = aggregateUnifiedInbox(triage);
    expect(inbox.deliveryItems).toHaveLength(1);
    const item = inbox.deliveryItems[0]!;
    expect(item.kind).toBe('delivery');
    expect(item.id).toBe('del-1');
    expect(item.status).toBe('failed');
    expect(item.target.surfaceKind).toBe('slack');
    expect(item.target.routeId).toBe('ops');
    expect(item.target.label).toBe('Ops');
    expect(item.startedAt).toBe(1000);
    expect(item.endedAt).toBe(2000);
    expect(item.error).toBe('connection refused');
    expect(inbox.summary.attentionCount).toBe(1);
    expect(inbox.summary.failureCount).toBe(1);
    expect(inbox.status).toBe('attention');
  });

  test('maps surface message items', () => {
    const triage = makeTriage({
      surfaceMessages: {
        route: '/api/control-plane/messages',
        state: 'ready',
        totalMessages: 1,
        messages: [
          {
            id: 'msg-1',
            surface: 'web',
            level: 'info',
            title: 'Automation complete',
            bodyPreview: 'Your routine ran.',
            routeId: 'route-a',
            surfaceId: 'client-1',
            clientId: 'c1',
            attachmentCount: 2,
            createdAt: 99000,
          },
        ],
      },
    });
    const inbox = aggregateUnifiedInbox(triage);
    expect(inbox.surfaceMessageItems).toHaveLength(1);
    const item = inbox.surfaceMessageItems[0]!;
    expect(item.kind).toBe('surface_message');
    expect(item.id).toBe('msg-1');
    expect(item.surface).toBe('web');
    expect(item.level).toBe('info');
    expect(item.title).toBe('Automation complete');
    expect(item.bodyPreview).toBe('Your routine ran.');
    expect(item.routeId).toBe('route-a');
    expect(item.attachmentCount).toBe(2);
    expect(item.createdAt).toBe(99000);
  });

  test('maps route binding items', () => {
    const triage = makeTriage({
      routeBindings: {
        route: '/api/routes/bindings',
        state: 'ready',
        totalBindings: 1,
        bindings: [
          {
            id: 'bind-1',
            kind: 'companion',
            surfaceKind: 'slack',
            surfaceId: 'W123',
            externalIdDigest: 'sha256:abcdef',
            sessionPolicy: 'new',
            threadPolicy: 'continue',
            deliveryGuarantee: 'at_least_once',
            lastSeenAt: 50000,
            sessionId: 'sess-1',
            runId: 'run-x',
            jobId: 'job-x',
          },
        ],
      },
    });
    const inbox = aggregateUnifiedInbox(triage);
    expect(inbox.routeBindingItems).toHaveLength(1);
    const item = inbox.routeBindingItems[0]!;
    expect(item.kind).toBe('route_binding');
    expect(item.id).toBe('bind-1');
    expect(item.surfaceKind).toBe('slack');
    expect(item.externalIdDigest).toBe('sha256:abcdef');
    expect(item.sessionPolicy).toBe('new');
    expect(item.deliveryGuarantee).toBe('at_least_once');
    expect(item.lastSeenAt).toBe(50000);
  });

  test('reports blocked status when all sources unavailable', () => {
    const triage = makeTriage({
      deliveries: { route: '/api/deliveries', state: 'unavailable', kind: 'offline', message: 'not connected', totalAttempts: 0, attentionCount: 0, retryCandidateCount: 0, retryCandidates: [], attempts: [], totals: null },
      surfaceMessages: { route: '/api/control-plane/messages', state: 'unavailable', kind: 'offline', message: 'not connected', totalMessages: 0, messages: [] },
      routeBindings: { route: '/api/routes/bindings', state: 'unavailable', kind: 'offline', message: 'not connected', totalBindings: 0, bindings: [] },
    });
    const inbox = aggregateUnifiedInbox(triage);
    expect(inbox.status).toBe('blocked');
    expect(inbox.sources.every((s) => s.state === 'unavailable')).toBe(true);
  });

  test('respects limit option', () => {
    const attempts = Array.from({ length: 10 }, (_, i) => ({
      id: `del-${i}`,
      runId: `run-${i}`,
      jobId: `job-${i}`,
      status: 'completed',
      target: { kind: 'surface', surfaceKind: 'slack' },
      inspectRoute: `/api/deliveries/del-${i}`,
      modelRoute: '',
    }));
    const triage = makeTriage({
      deliveries: { route: '/api/deliveries', state: 'ready', totalAttempts: 10, attentionCount: 0, retryCandidateCount: 0, retryCandidates: [], attempts, totals: null },
    });
    const inbox = aggregateUnifiedInbox(triage, { limit: 3 });
    expect(inbox.deliveryItems).toHaveLength(3);
  });

  test('a caller that supplied no feed is reported as not having asked for one', () => {
    // The aggregate is a pure transformation and performs no I/O, so with no
    // feed handed to it the only honest thing it can say is that nothing was
    // asked. Naming a cause it did not observe, an unpublished contract, an
    // unreachable daemon, would send a reader to fix the wrong thing.
    const inbox = aggregateUnifiedInbox(makeTriage());
    expect(inbox.inboundChannelFeed.available).toBe(false);
    if (!inbox.inboundChannelFeed.available) {
      expect(inbox.inboundChannelFeed.reason).toBe('not_attempted');
      expect(inbox.inboundChannelFeed.methodId).toBe('channels.inbox.list');
    }
  });

  test('aggregates all three item kinds into a flat items array', () => {
    const triage = makeTriage({
      deliveries: {
        route: '/api/deliveries',
        state: 'ready',
        totalAttempts: 1,
        attentionCount: 0,
        retryCandidateCount: 0,
        retryCandidates: [],
        attempts: [{ id: 'd1', runId: 'r1', jobId: 'j1', status: 'completed', target: { kind: 'surface', surfaceKind: 'slack' }, inspectRoute: '/api/deliveries/d1', modelRoute: '' }],
        totals: null,
      },
      surfaceMessages: {
        route: '/api/control-plane/messages',
        state: 'ready',
        totalMessages: 1,
        messages: [{ id: 'm1', surface: 'web', level: 'info', title: 'T', bodyPreview: 'B', routeId: null, surfaceId: null, clientId: null, attachmentCount: 0, createdAt: null }],
      },
      routeBindings: {
        route: '/api/routes/bindings',
        state: 'ready',
        totalBindings: 1,
        bindings: [{ id: 'b1', kind: 'companion', surfaceKind: 'slack', surfaceId: null, externalIdDigest: null, sessionPolicy: null, threadPolicy: null, deliveryGuarantee: null, lastSeenAt: null, sessionId: null, runId: null, jobId: null }],
      },
    });
    const inbox = aggregateUnifiedInbox(triage);
    expect(inbox.summary.totalItems).toBe(3);
    const kinds = inbox.items.map((i) => i.kind);
    expect(kinds).toContain('delivery');
    expect(kinds).toContain('surface_message');
    expect(kinds).toContain('route_binding');
  });
});

describe('formatUnifiedInbox', () => {
  test('produces non-empty string with header', () => {
    const inbox = aggregateUnifiedInbox(makeTriage());
    const formatted = formatUnifiedInbox(inbox);
    expect(formatted).toContain('Unified Inbox');
    expect(formatted).toContain('status:');
    expect(formatted).toContain('channels.inbox.list');
  });

  test('includes delivery item lines when present', () => {
    const triage = makeTriage({
      deliveries: {
        route: '/api/deliveries',
        state: 'ready',
        totalAttempts: 1,
        attentionCount: 0,
        retryCandidateCount: 0,
        retryCandidates: [],
        attempts: [{ id: 'del-x', runId: 'r', jobId: 'j', status: 'failed', target: { kind: 'surface', surfaceKind: 'discord' }, inspectRoute: '/api/deliveries/del-x', modelRoute: '' }],
        totals: null,
      },
    });
    const formatted = formatUnifiedInbox(aggregateUnifiedInbox(triage));
    expect(formatted).toContain('del-x');
    expect(formatted).toContain('discord');
  });
});
