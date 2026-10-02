import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import {
  createNotificationDispatcher, wireRuntimeNotificationBridge,
  personFacingEvent, NOTIFICATION_BRIDGE_DOMAINS,
} from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';
import { SAMPLES } from '../helpers/contract-event-samples.ts';

const fakeConfig = { get: configGetStub() };
const context = { sessionId: 'fixture-session', source: 'notification-dispatch-test' };

describe('notification dispatch: canonical runtime facts', () => {
  test('a panel-only decision lands in the actual feed', () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    dispatcher.router.setDomainVerbosity('agents', 'minimal');
    const decision = dispatcher.dispatch({ id: 'fixture-notification', domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 });
    expect(decision.target).toBe('panel_only');
    expect(feed.list()).toMatchObject([{ title: 'Agent finished', domain: 'agents' }]);
  });

  test('canonical contract terminal events flow through the actual bus into the feed', async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    const bus = new RuntimeEventBus();
    const stop = wireRuntimeNotificationBridge(bus, dispatcher);
    try {
      for (const event of [SAMPLES.CONTRACT_PASSED, SAMPLES.CONTRACT_CANCELLED]) {
        // Isolate occurrences from optional batch collapsing, using its public API.
        dispatcher.router.setBatchWindowMs(1);
        bus.emit('contracts', createEventEnvelope(event.type, event, context));
        await Promise.resolve();
      }
      expect(feed.list().map((entry) => entry.title)).toEqual(['Workstream cancelled', 'Workstream passed']);
      expect(feed.list().every((entry) => entry.domain === 'contracts' && entry.subject === 'agents')).toBe(true);
      expect(feed.list()[0]?.level).toBe('info');
    } finally { stop(); }
  });

  test('internal events and retired workflow types stay outside the bridge allowlist', async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    const bus = new RuntimeEventBus();
    const stop = wireRuntimeNotificationBridge(bus, dispatcher);
    try {
      bus.emit('agents', createEventEnvelope('AGENT_PROGRESS', { type: 'AGENT_PROGRESS', agentId: 'agent-1', progress: 'Synthetic progress' }, context));
      bus.emit('contracts', createEventEnvelope('CONTRACT_GATE_RESULT', SAMPLES.CONTRACT_GATE_RESULT, context));
      bus.emit('contracts', createEventEnvelope('CONTRACT_STATUS_CHANGED', SAMPLES.CONTRACT_STATUS_CHANGED, context));
      await Promise.resolve();
      expect(feed.list()).toEqual([]);
      expect(NOTIFICATION_BRIDGE_DOMAINS).toContain('contracts');
      expect(NOTIFICATION_BRIDGE_DOMAINS).not.toContain('workflows');
      for (const type of ['WORKFLOW_CHAIN_PASSED', 'WORKFLOW_CHAIN_FAILED', 'WORKFLOW_GATE_RESULT', 'CONTRACT_GATE_RESULT', 'UNKNOWN_EVENT', 'toString']) {
        expect(personFacingEvent(type)).toBeUndefined();
      }
      expect(personFacingEvent('CONTRACT_FAILED')).toEqual({ title: 'Workstream failed', level: 'warning' });
      expect(personFacingEvent('CONTRACT_CANCELLED')).toEqual({ title: 'Workstream cancelled', level: 'info' });
    } finally { stop(); }
  });

  for (const [status, title, level] of [
    ['committed', 'Changes committed', 'info'], ['applied', 'Changes applied', 'info'],
    ['skipped', 'Commit skipped', 'info'], ['failed', 'Commit failed', 'warning'],
  ] as const) {
    test(`commit ${status} uses the typed status despite contradictory note wording`, async () => {
      const dispatched: Array<{ title: string; level: string; body?: string }> = [];
      const bus = new RuntimeEventBus();
      const stop = wireRuntimeNotificationBridge(bus, { dispatch: (notice) => { dispatched.push(notice); return { target: 'panel_only', reasonCode: 'allowed' }; } });
      try {
        bus.emit('contracts', createEventEnvelope('CONTRACT_COMMITTED', {
          ...SAMPLES.CONTRACT_COMMITTED, status, note: 'Failed cancelled committed: synthetic prose with no semantic authority',
        }, context));
        await Promise.resolve();
        expect(dispatched).toMatchObject([{ title, level, body: 'Failed cancelled committed: synthetic prose with no semantic authority' }]);
      } finally { stop(); }
    });
  }

  test('an unsupported commit status is not presented as a successful commit', () => {
    expect(personFacingEvent('CONTRACT_COMMITTED', { status: 'unrecognized', note: 'Committed' })).toBeUndefined();
  });
});
