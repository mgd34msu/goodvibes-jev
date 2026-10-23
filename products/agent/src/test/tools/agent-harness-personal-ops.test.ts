import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { createHarnessArtifactStore, makeFixture, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


afterAll(cleanupResearchScreeningFixtures);

describe('agent_harness tool', () => {
let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    fixtureLog = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
  });
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });


  test.each(['summary', 'lanes', 'intake', 'usage', 'reminders', 'notes'] as const)('exposes Personal Ops %s without faking email or calendar connectors', async surface => {
    const fixture = makeFixture();
    try {
      AgentNoteRegistry.fromShellPaths(fixture.paths).create({
        title: 'Follow-up queue',
        body: 'Track pending replies, reminders, and handoffs here.',
        tags: ['personal-ops'],
        source: 'agent',
        provenance: 'test',
      });

      if (surface === 'summary') {
        const summary = await executeHarnessJson<{
          readonly personalOps?: { readonly lanes: number; readonly gap: number; readonly ready: number; readonly workflows: number; readonly setupWorkflows: number; readonly capabilityDiscovery: string };
        }>(fixture, { mode: 'summary' });
        expect(summary.personalOps?.lanes).toBe(7);
        // The startup summary counts native registrations. Discovering actual
        // capabilities and workflows belongs to the awaited personal_ops read below.
        expect(summary.personalOps?.gap).toBe(4);
        expect(summary.personalOps?.ready).toBeGreaterThan(0);
        expect(summary.personalOps?.workflows).toBe(0);
        expect(summary.personalOps?.capabilityDiscovery).toBe('read-on-request');
        expect(summary.personalOps?.setupWorkflows).toBe(0);
      }

      if (surface === 'lanes') {
        const ops = await executeHarnessJson<{
          readonly workflowSummary: { readonly workflows: number; readonly needsSetup: number };
          readonly lanes: readonly {
            readonly id: string;
            readonly status: string;
            readonly current: string;
            readonly methodIds?: readonly string[];
            readonly workflows?: readonly {
              readonly id: string;
              readonly status: string;
              readonly modelRoute: string;
              readonly inspectRoutes?: readonly string[];
              readonly prerequisites?: readonly string[];
              readonly runBoundary?: string;
            }[];
            readonly liveRecords?: readonly {
              readonly id: string;
              readonly label: string;
              readonly status: string;
              readonly summary: string;
              readonly modelRoute: string;
              readonly tags?: readonly string[];
              readonly effect?: string;
              readonly capability?: string;
              readonly confirmationRequired?: boolean;
            }[];
          }[];
          readonly policy: string;
          readonly nextActions: readonly string[];
        }>(fixture, { mode: 'personal_ops', includeParameters: true });
        expect(ops.policy).toContain('Missing email/calendar connectors');
        expect(ops.nextActions.join('\n')).toContain('Inbox');
        // 4 needs-setup workflows after the unshipped writing-style draft-reply workflow
        // was pulled from the advertised inbox lane (capability-honesty, 2026-07).
        expect(ops.workflowSummary.needsSetup).toBe(0);

        const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
        const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
        const notes = ops.lanes.find((lane) => lane.id === 'notes');
        const tasks = ops.lanes.find((lane) => lane.id === 'tasks');
        const reminders = ops.lanes.find((lane) => lane.id === 'reminders');
        const delivery = ops.lanes.find((lane) => lane.id === 'delivery');
        // The methods are served now, so the lane names them instead of
        // explaining why nothing can be called. It still does not claim a live
        // mailbox: the card tells the model to inspect the schema before acting,
        // which is the honest position when a route exists but no account does.
        expect(inbox?.status).toBe('partial');
        expect(inbox?.current).toContain('exposes email-like methods');
        expect(inbox?.methodIds).toEqual(expect.arrayContaining([
          'email.inbox.list', 'email.inbox.read', 'email.send', 'email.draft.create',
        ]));
        expect(inbox?.workflows?.[0]?.id).toBe('inbox-triage-briefing');
        expect(inbox?.workflows?.[0]?.status).toBe('ready');
        // The card now leads with a route that inspects a REAL method schema,
        // because there is one to inspect. Before the daemon served email.* the
        // best it could offer was a pointer back at the lane.
        expect(inbox?.workflows?.[0]?.inspectRoutes?.[0]).toContain('host action:"method"');
        expect(inbox?.workflows?.[0]?.inspectRoutes?.join('\n')).toContain('email.');
        expect(inbox?.workflows?.[0]?.prerequisites?.join('\n')).toContain('Inspect the exact connector or daemon method schema');
        expect(inbox?.workflows?.[0]?.runBoundary).toContain('confirmation');
        expect(calendar?.status).toBe('partial');
        expect(calendar?.methodIds).toEqual(expect.arrayContaining(['calendar.events.list', 'calendar.events.create']));
        expect(calendar?.workflows?.[0]?.id).toBe('calendar-agenda-briefing');
        expect(calendar?.workflows?.[0]?.status).toBe('ready');
        expect(notes?.status).toBe('ready');
        expect(notes?.current).toContain('1 note');
        expect(notes?.liveRecords?.[0]?.id).toBe('follow-up-queue');
        expect(notes?.liveRecords?.[0]?.label).toBe('Follow-up queue');
        expect(notes?.liveRecords?.[0]?.modelRoute).toContain('agent_local_registry');
        expect(tasks?.methodIds).toContain('tasks.list');
        expect(tasks?.workflows?.map((workflow) => workflow.id)).toEqual(expect.arrayContaining([
          'visible-work-plan-review',
          'connected-host-task-review',
        ]));
        expect(tasks?.workflows?.find((workflow) => workflow.id === 'connected-host-task-review')?.inspectRoutes?.join('\n')).toContain('tasks.list');
        const workPlanAdd = tasks?.liveRecords?.find((record) => record.id === 'workplan-add');
        const workPlanStatus = tasks?.liveRecords?.find((record) => record.id === 'workplan-status');
        expect(workPlanAdd?.modelRoute).toContain('action:"create"');
        expect(workPlanAdd?.confirmationRequired).toBe(false);
        expect(workPlanStatus?.modelRoute).toContain('action:"set_status"');
        expect(tasks?.liveRecords?.find((record) => record.id === 'host-tasks-list')?.effect).toBe('read-only');
        expect(tasks?.liveRecords?.find((record) => record.id === 'host-task-cancel')?.modelRoute).toContain('agent_operator_method');
        expect(reminders?.methodIds).toContain('automation.schedules.create');
        expect(reminders?.workflows?.map((workflow) => workflow.id)).toEqual(expect.arrayContaining([
          'confirmed-reminder-request',
          'connected-schedule-review',
        ]));
        expect(reminders?.workflows?.find((workflow) => workflow.id === 'connected-schedule-review')?.inspectRoutes?.join('\n')).toContain('schedule-list');
        const reminderCreate = reminders?.liveRecords?.find((record) => record.id === 'reminder-create');
        expect(reminderCreate?.modelRoute).toContain('schedule action:"remind"');
        expect(reminderCreate?.confirmationRequired).toBe(true);
        expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-list')?.effect).toBe('read-only');
        expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-edit')?.modelRoute).toContain('schedule action:"edit"');
        expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-pause')?.modelRoute).toContain('schedule action:"pause"');
        expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-resume')?.modelRoute).toContain('schedule action:"resume"');
        expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-delete')?.modelRoute).toContain('schedule action:"delete"');
        expect(delivery?.liveRecords?.some((record) => record.modelRoute.includes('channels action:"channel"'))).toBe(true);
      }

      if (surface === 'intake') {
        const missingIntake = await executeHarnessJson<{
          readonly status: string;
          readonly preferred: {
            readonly id: string;
            readonly laneId: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly inspectRoutes: readonly string[];
            readonly missingFields?: readonly string[];
            readonly safetyBoundary: string;
          };
          readonly laneRoute: string;
          readonly policy: string;
        }>(fixture, { mode: 'personal_ops_intake', query: 'Triage my unread inbox.' });
        expect(missingIntake.status).toBe('ready');
        expect(missingIntake.preferred.id).toBe('inbox-triage-briefing');
        expect(missingIntake.preferred.laneId).toBe('inbox');
        // Honest intake: the matched workflow now reports ready, because a
        // dispatchable email method genuinely exists (the daemon serves email.*).
        // The honesty this asserts moved down a level: 'ready' here means "there
        // is a route to inspect", and the card's own prerequisites still require
        // inspecting the schema before any mailbox is claimed.
        expect(missingIntake.preferred.status).toBe('ready');
        expect(missingIntake.preferred.modelRoute).toContain('host action:"methods"');
        // Every inspect route names a real, dispatchable method now. The
        // unified inbox verb (channels.inbox.list, it merges Slack/Discord/
        // email threads into one feed, see src/agent/unified-inbox.ts) sorts
        // first alphabetically among the matched email-lane methods, ahead of
        // email.inbox.list itself.
        expect(missingIntake.preferred.inspectRoutes.join('\n')).toContain('host action:"method" methodId:"channels.inbox.list"');
        // Nothing is missing to INSPECT any more: the method exists. The card
        // reports no missing field rather than naming one it no longer needs.
        expect(missingIntake.preferred.missingFields ?? []).toEqual([]);
        expect(missingIntake.preferred.safetyBoundary).toContain('confirmation');
        expect(missingIntake.laneRoute).toContain('laneId:"inbox"');
        expect(missingIntake.policy).toContain('read-only');
      }

      if (surface === 'usage') {
        const missingUsage = await executeHarnessJson<{
          readonly status: string;
          readonly usage: string;
          readonly examples: readonly string[];
        }>(fixture, { mode: 'personal_ops_intake' });
        expect(missingUsage.status).toBe('missing_request');
        expect(missingUsage.usage).toContain('personal_ops action:"intake"');
        expect(missingUsage.examples.join('\n')).toContain('Brief my calendar');
      }

      if (surface === 'reminders') {
        const lane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly routes?: { readonly model: string };
        }>(fixture, { mode: 'personal_ops_lane', laneId: 'reminders' });
        expect(lane.id).toBe('reminders');
        expect(lane.status).toBe('ready');
        expect(lane.routes?.model).toContain('schedule action:"remind|create"');
      }

      if (surface === 'notes') {
        const notesLane = await executeHarnessJson<{
          readonly id: string;
          readonly liveRecords?: readonly { readonly id: string; readonly modelRoute: string }[];
        }>(fixture, { mode: 'personal_ops_lane', laneId: 'notes' });
        expect(notesLane.liveRecords?.[0]?.id).toBe('follow-up-queue');
        expect(notesLane.liveRecords?.[0]?.modelRoute).toContain('action:"get"');
      }
    } finally {
      fixture.cleanup();
    }
  });


  test('surfaces saved Personal Ops review artifacts as durable lane queue records', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'saved-inbox-review.json',
      text: '{"reviewRecords":[]}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-review-cards',
        laneId: 'inbox',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
        reviewRecordCount: 2,
        reviewLabels: ['Escalation follow-up', 'Weekly planning'],
        reviewRecordIds: ['msg-escalation', 'msg-planning'],
        fullRawConnectorOutputStored: false,
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'saved-calendar-review.json',
      text: '{"reviewRecords":[]}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-review-cards',
        laneId: 'calendar',
        sourceTool: 'mcp:calendar:calendar.list_events',
        reviewRecordCount: 1,
        reviewLabels: ['Weekly sync'],
        reviewRecordIds: ['evt-weekly-sync'],
        fullRawConnectorOutputStored: false,
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const ops = await executeHarnessJson<{
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly artifactId?: string;
            readonly reviewRecordCount?: number;
            readonly reviewLabels?: readonly string[];
            readonly sourceTool?: string;
            readonly freshness?: {
              readonly status: string;
              readonly source: string;
              readonly sourceTool?: string;
              readonly refreshRoute?: string;
              readonly policy: string;
            };
            readonly followUpRoutes?: readonly {
              readonly id: string;
              readonly effect: string;
              readonly modelRoute: string;
              readonly requiresConfirmation: boolean;
              readonly policy: string;
            }[];
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const savedReview = inbox?.liveRecords?.find((record) => record.id === 'review-artifact:artifact-1');
      const savedThread = inbox?.liveRecords?.find((record) => record.id === 'review-thread:artifact-1:msg-escalation');
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('thread queue items');
      expect(inbox?.signals).toContain('1 saved inbox review artifact(s)');
      expect(inbox?.signals).toContain('2 saved inbox thread queue item(s)');
      expect(inbox?.signals).toContain('0 refreshable saved inbox queue item(s)');
      expect(savedThread?.label).toContain('Saved thread');
      expect(savedThread?.status).toBe('ready-for-draft');
      expect(savedThread?.capability).toBe('inbox-thread-review');
      expect(savedThread?.tags).toContain('draft-ready');
      expect(savedThread?.modelRoute).toContain('agent_artifacts show artifactId:"artifact-1"');
      expect(savedThread?.freshness).toMatchObject({
        status: 'provider-contract-missing',
        source: 'saved-review-artifact',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
      });
      expect(savedThread?.freshness?.refreshRoute).toBeUndefined();
      expect(savedThread?.freshness?.policy).toContain('matching read-only connector route');
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'draft-local-reply')?.requiresConfirmation).toBe(false);
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.policy).toContain('user confirms exact recipients and body');
      expect(savedReview?.label).toContain('Saved inbox review');
      expect(savedReview?.status).toBe('ready');
      expect(savedReview?.summary).toContain('2 normalized review cards');
      expect(savedReview?.summary).toContain('Escalation follow-up');
      expect(savedReview?.modelRoute).toContain('agent_artifacts show artifactId:"artifact-1"');
      expect(savedReview?.tags).toContain('saved-review');
      expect(savedReview?.effect).toBe('read-only');
      expect(savedReview?.capability).toBe('inbox-review-artifact');
      expect(savedReview?.artifactId).toBe('artifact-1');
      expect(savedReview?.reviewRecordCount).toBe(2);
      expect(savedReview?.reviewLabels).toEqual(['Escalation follow-up', 'Weekly planning']);
      expect(savedReview?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(savedReview?.freshness?.status).toBe('provider-contract-missing');

      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      const savedEvent = calendar?.liveRecords?.find((record) => record.id === 'review-event:artifact-2:evt-weekly-sync');
      expect(calendar?.signals).toContain('1 saved calendar review artifact(s)');
      expect(calendar?.signals).toContain('1 saved calendar event queue item(s)');
      expect(calendar?.signals).toContain('0 refreshable saved calendar queue item(s)');
      expect(savedEvent?.label).toContain('Saved event');
      expect(savedEvent?.status).toBe('ready-for-reminder');
      expect(savedEvent?.capability).toBe('calendar-event-review');
      expect(savedEvent?.tags).toContain('reminder-ready');
      expect(savedEvent?.freshness?.status).toBe('provider-contract-missing');
      expect(savedEvent?.followUpRoutes?.find((route) => route.id === 'create-reminder-from-event')?.modelRoute).toContain('schedule action:"remind"');
      expect(savedEvent?.followUpRoutes?.find((route) => route.id === 'calendar-edit-boundary')?.requiresConfirmation).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['lanes', 'queue', 'briefing'] as const)('surfaces daemon-published Personal Ops inbox and calendar %s as current queues', async surface => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.personalOps = {
        inboxThreads: {
          getSnapshot: () => ({
            threads: [{
              providerId: 'gmail',
              threadId: 'thread-secure-1',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.inbox-thread.v1',
              publicationGuarantee: 'daemon publishes thread snapshots after Gmail history sync token=gmail-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method gmail.threads.list', 'sourceTool personalOps.inboxThreads'],
              effectReceiptIds: ['gmail-reply-receipt-1', 'gmail-archive-receipt-1'],
              subject: 'Quarterly budget follow-up',
              status: 'unread',
              from: 'lead@example.test',
              labels: ['inbox', 'finance'],
              receivedAt: '2026-06-07T10:00:00Z',
              snippet: 'token=SECRET123 password=hunter2 Please review the budget.',
              readRoute: 'personal_ops_provider action:"read_thread" threadId:"thread-secure-1"',
              replyRoute: 'personal_ops_provider action:"reply_thread" threadId:"thread-secure-1" confirm:true',
              archiveRoute: 'personal_ops_provider action:"archive_thread" threadId:"thread-secure-1" confirm:true',
            }],
          }),
        },
        calendarEvents: {
          getSnapshot: () => ({
            events: [{
              providerId: 'caldav',
              eventId: 'evt-board-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.calendar-event.v1',
              publicationGuarantee: 'daemon publishes event snapshots after CalDAV sync credential=caldav-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method calendar.events.list', 'sourceTool personalOps.calendarEvents'],
              effectReceiptIds: ['caldav-edit-receipt-1', 'caldav-rsvp-receipt-1'],
              calendarId: 'primary',
              title: 'Board review',
              start: '2026-06-08T15:00:00Z',
              conflicts: [{ eventId: 'evt-overlap' }],
              preview: 'credential=calendar-secret Prep packet is ready.',
              editRoute: 'personal_ops_provider action:"edit_event" eventId:"evt-board-review" confirm:true',
              rsvpRoute: 'personal_ops_provider action:"rsvp_event" eventId:"evt-board-review" confirm:true',
            }],
          }),
        },
      };

      if (surface === 'lanes') {
        const ops = await executeHarnessJson<{
          readonly lanes: readonly {
            readonly id: string;
            readonly status: string;
            readonly current: string;
            readonly next: string;
            readonly signals: readonly string[];
            readonly liveRecords?: readonly {
              readonly id: string;
              readonly label: string;
              readonly status: string;
              readonly summary: string;
              readonly modelRoute: string;
              readonly tags?: readonly string[];
              readonly effect?: string;
              readonly capability?: string;
              readonly confirmationRequired?: boolean;
              readonly sourceTool?: string;
              readonly certification?: {
                readonly schemaStatus: string;
                readonly schemaVersion?: string;
                readonly publicationGuarantee?: string;
                readonly publisher?: string;
                readonly provenance?: readonly string[];
                readonly receiptIds?: readonly string[];
                readonly missingSignals: readonly string[];
                readonly policy: string;
              };
              readonly freshness?: {
                readonly status: string;
                readonly source: string;
                readonly sourceTool?: string;
                readonly refreshRoute?: string;
                readonly sampleInput?: Record<string, unknown>;
              };
              readonly followUpRoutes?: readonly {
                readonly id: string;
                readonly effect: string;
                readonly modelRoute: string;
                readonly requiresConfirmation: boolean;
                readonly policy: string;
              }[];
            }[];
          }[];
        }>(fixture, { mode: 'personal_ops', includeParameters: true });

        const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
        const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
        expect(inbox?.status).toBe('ready');
        expect(inbox?.current).toContain('Fresh provider-backed inbox thread records');
        expect(inbox?.next).toContain('published confirmed follow-up routes');
        expect(inbox?.signals).toContain('1 fresh provider-backed inbox thread record(s)');
        const thread = inbox?.liveRecords?.find((record) => record.capability === 'inbox-provider-thread');
        expect(thread?.label).toContain('Fresh thread');
        expect(thread?.effect).toBe('read-only');
        expect(thread?.confirmationRequired).toBe(false);
        expect(thread?.sourceTool).toBe('context.platform.readModels.personalOps.inboxThreads');
        expect(thread?.certification?.schemaStatus).toBe('legacy');
        expect(thread?.certification?.schemaVersion).toBe('goodvibes.personal-ops.inbox-thread.v1');
        expect(thread?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
        expect(thread?.certification?.publicationGuarantee).not.toContain('gmail-pub-secret');
        expect(thread?.certification?.publisher).toBe('goodvibes-daemon');
        expect(thread?.certification?.provenance?.join('\n')).toContain('gmail.threads.list');
        expect(thread?.certification?.receiptIds).toEqual(['gmail-reply-receipt-1', 'gmail-archive-receipt-1']);
        expect(thread?.certification?.missingSignals).toEqual(['Native host or SDK inbox thread schema attestation is not published.']);
        expect(thread?.modelRoute).toContain('read_thread');
        expect(thread?.summary).toContain('token=[REDACTED]');
        expect(thread?.summary).not.toContain('SECRET123');
        expect(thread?.summary).not.toContain('hunter2');
        expect(thread?.tags).toContain('provider-backed');
        expect(thread?.freshness).toMatchObject({
          status: 'fresh-provider-route-ready',
          source: 'daemon-read-model',
          sourceTool: 'context.platform.readModels.personalOps.inboxThreads',
          sampleInput: { threadId: 'thread-secure-1' },
        });
        expect(thread?.freshness?.refreshRoute).toContain('read_thread');
        expect(thread?.followUpRoutes?.find((route) => route.id === 'inspect-provider-thread')?.requiresConfirmation).toBe(false);
        expect(thread?.followUpRoutes?.find((route) => route.id === 'reply-provider-thread')?.requiresConfirmation).toBe(true);
        expect(thread?.followUpRoutes?.find((route) => route.id === 'archive-provider-thread')?.policy).toContain('requires an explicit user request');

        expect(calendar?.status).toBe('ready');
        expect(calendar?.current).toContain('Fresh provider-backed calendar event records');
        expect(calendar?.signals).toContain('1 fresh provider-backed calendar event record(s)');
        const event = calendar?.liveRecords?.find((record) => record.capability === 'calendar-provider-event');
        expect(event?.label).toContain('Fresh event');
        expect(event?.status).toBe('conflict');
        expect(event?.certification?.schemaStatus).toBe('legacy');
        expect(event?.certification?.publicationGuarantee).toContain('credential=[REDACTED]');
        expect(event?.certification?.publicationGuarantee).not.toContain('caldav-pub-secret');
        expect(event?.certification?.receiptIds).toEqual(['caldav-edit-receipt-1', 'caldav-rsvp-receipt-1']);
        expect(event?.certification?.missingSignals).toEqual(['Native host or SDK calendar event schema attestation is not published.']);
        expect(event?.summary).toContain('1 conflict signal');
        expect(event?.summary).toContain('credential=[REDACTED]');
        expect(event?.summary).not.toContain('calendar-secret');
        expect(event?.modelRoute).toContain('laneId:"calendar"');
        expect(event?.freshness).toMatchObject({
          status: 'fresh-provider-record-current',
          source: 'daemon-read-model',
          sourceTool: 'context.platform.readModels.personalOps.calendarEvents',
          sampleInput: { eventId: 'evt-board-review', calendarId: 'primary' },
        });
        expect(event?.freshness?.refreshRoute).toBeUndefined();
        expect(event?.followUpRoutes?.find((route) => route.id === 'inspect-provider-event')?.requiresConfirmation).toBe(false);
        expect(event?.followUpRoutes?.find((route) => route.id === 'edit-provider-event')?.requiresConfirmation).toBe(true);
        expect(event?.followUpRoutes?.find((route) => route.id === 'rsvp-provider-event')?.requiresConfirmation).toBe(true);
      }

      if (surface === 'queue') {
        const queue = await executeHarnessJson<{
          readonly status: string;
          readonly summary: { readonly inbox: number; readonly calendar: number; readonly freshProviderReads: number; readonly confirmedFollowUps: number };
          readonly queue: readonly {
            readonly laneId: string;
            readonly type: string;
            readonly capability?: string;
            readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] };
            readonly freshness?: { readonly status: string; readonly source: string; readonly refreshRoute?: string };
            readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean }[];
          }[];
          readonly nextActions: readonly string[];
        }>(fixture, { mode: 'personal_ops_queue', includeParameters: true });
        expect(queue.status).toBe('ready');
        expect(queue.summary.inbox).toBe(1);
        expect(queue.summary.calendar).toBe(1);
        expect(queue.summary.freshProviderReads).toBe(2);
        expect(queue.summary.confirmedFollowUps).toBeGreaterThanOrEqual(4);
        expect(queue.queue.find((record) => record.capability === 'inbox-provider-thread')?.type).toBe('fresh-provider-read');
        expect(queue.queue.find((record) => record.capability === 'calendar-provider-event')?.type).toBe('fresh-provider-record');
        expect(queue.queue.find((record) => record.capability === 'inbox-provider-thread')?.certification?.schemaStatus).toBe('legacy');
        expect(queue.queue.find((record) => record.capability === 'calendar-provider-event')?.certification?.missingSignals).toEqual(['Native host or SDK calendar event schema attestation is not published.']);
        expect(queue.nextActions.join('\n')).toContain('Inspect one current provider-backed queue record');
      }

      if (surface === 'briefing') {
        const briefing = await executeHarnessJson<{
          readonly steps: readonly {
            readonly id: string;
            readonly status: string;
            readonly next: string;
            readonly sourceCounts: { readonly freshProviderReads?: number };
          }[];
          readonly missingContracts?: readonly string[];
        }>(fixture, { mode: 'personal_ops_briefing', includeParameters: true });
        const inboxBrief = briefing.steps.find((step) => step.id === 'inbox');
        const calendarBrief = briefing.steps.find((step) => step.id === 'calendar');
        expect(inboxBrief?.status).toBe('ready');
        expect(calendarBrief?.status).toBe('ready');
        expect(inboxBrief?.sourceCounts.freshProviderReads).toBe(1);
        expect(calendarBrief?.sourceCounts.freshProviderReads).toBe(1);
        expect(inboxBrief?.next).toContain('Inspect one current provider-backed record');
        expect(briefing.missingContracts ?? []).toEqual([]);
      }
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['tasks', 'reminders', 'briefing'] as const)('surfaces daemon-published Personal Ops task and reminder %s as current provider queues', async surface => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.personalOps = {
        tasks: {
          getSnapshot: () => ({
            tasks: [{
              providerId: 'todoist',
              taskId: 'task-budget-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.task.v1',
              publicationGuarantee: 'daemon publishes task snapshots after provider sync token=task-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method tasks.list', 'sourceTool personalOps.tasks'],
              effectReceiptIds: ['todoist-update-receipt-1', 'todoist-complete-receipt-1'],
              title: 'Review budget task',
              status: 'active',
              project: 'Finance',
              dueAt: '2026-06-09T14:00:00Z',
              priority: 'high',
              assignee: 'owner@example.test',
              labels: ['finance', 'review'],
              preview: 'token=TASKSECRET Check the latest budget.',
              readRoute: 'personal_ops_provider action:"read_task" taskId:"task-budget-review"',
              updateRoute: 'personal_ops_provider action:"update_task" taskId:"task-budget-review" confirm:true',
              completeRoute: 'personal_ops_provider action:"complete_task" taskId:"task-budget-review" confirm:true',
            }],
          }),
        },
        reminders: {
          getSnapshot: () => ({
            reminders: [{
              providerId: 'caldav',
              reminderId: 'reminder-report',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.reminder.v1',
              publicationGuarantee: 'daemon publishes reminder snapshots after schedule sync password=reminder-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method reminders.list', 'sourceTool personalOps.reminders'],
              effectReceiptIds: ['reminder-edit-receipt-1', 'reminder-snooze-receipt-1', 'reminder-delete-receipt-1'],
              title: 'Send report reminder',
              status: 'scheduled',
              remindAt: '2026-06-10T09:00:00Z',
              cadence: 'once',
              deliveryTarget: 'email',
              preview: 'password=REMINDERSECRET Draft is ready.',
              editRoute: 'personal_ops_provider action:"edit_reminder" reminderId:"reminder-report" confirm:true',
              snoozeRoute: 'personal_ops_provider action:"snooze_reminder" reminderId:"reminder-report" confirm:true',
              deleteRoute: 'personal_ops_provider action:"delete_reminder" reminderId:"reminder-report" confirm:true',
            }],
          }),
        },
      };

      if (surface === 'tasks') {
        const tasksLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly confirmationRequired?: boolean;
            readonly sourceTool?: string;
            readonly certification?: {
              readonly schemaStatus: string;
              readonly schemaVersion?: string;
              readonly publicationGuarantee?: string;
              readonly publisher?: string;
              readonly provenance?: readonly string[];
              readonly receiptIds?: readonly string[];
              readonly missingSignals: readonly string[];
            };
            readonly freshness?: {
              readonly status: string;
              readonly source: string;
              readonly sourceTool?: string;
              readonly refreshRoute?: string;
              readonly sampleInput?: Record<string, unknown>;
            };
            readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string; readonly policy: string }[];
          }[];
        }>(fixture, { mode: 'personal_ops_lane', laneId: 'tasks', includeParameters: true });
        expect(tasksLane.status).toBe('ready');
        expect(tasksLane.current).toContain('Fresh provider-backed task records');
        expect(tasksLane.next).toContain('published confirmed follow-up route');
        expect(tasksLane.signals).toContain('1 fresh provider-backed task record(s)');
        const taskRecord = tasksLane.liveRecords?.find((record) => record.capability === 'task-provider-record');
        expect(taskRecord?.label).toContain('Fresh task');
        expect(taskRecord?.effect).toBe('read-only');
        expect(taskRecord?.confirmationRequired).toBe(false);
        expect(taskRecord?.sourceTool).toBe('context.platform.readModels.personalOps.tasks');
        expect(taskRecord?.certification?.schemaStatus).toBe('legacy');
        expect(taskRecord?.certification?.schemaVersion).toBe('goodvibes.personal-ops.task.v1');
        expect(taskRecord?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
        expect(taskRecord?.certification?.publicationGuarantee).not.toContain('task-pub-secret');
        expect(taskRecord?.certification?.publisher).toBe('goodvibes-daemon');
        expect(taskRecord?.certification?.provenance?.join('\n')).toContain('tasks.list');
        expect(taskRecord?.certification?.receiptIds).toEqual(['todoist-update-receipt-1', 'todoist-complete-receipt-1']);
        expect(taskRecord?.certification?.missingSignals).toEqual(['Native host or SDK task schema attestation is not published.']);
        expect(taskRecord?.modelRoute).toContain('read_task');
        expect(taskRecord?.summary).toContain('token=[REDACTED]');
        expect(taskRecord?.summary).not.toContain('TASKSECRET');
        expect(taskRecord?.tags).toContain('provider-backed');
        expect(taskRecord?.freshness).toMatchObject({
          status: 'fresh-provider-route-ready',
          source: 'daemon-read-model',
          sourceTool: 'context.platform.readModels.personalOps.tasks',
          sampleInput: { taskId: 'task-budget-review' },
        });
        expect(taskRecord?.freshness?.refreshRoute).toContain('read_task');
        expect(taskRecord?.followUpRoutes?.find((route) => route.id === 'update-provider-task')?.requiresConfirmation).toBe(true);
        expect(taskRecord?.followUpRoutes?.find((route) => route.id === 'complete-provider-task')?.policy).toContain('requires explicit confirmation');
        expect(tasksLane.liveRecords?.find((record) => record.id === 'workplan-list')).toBeDefined();
      }

      if (surface === 'reminders') {
        const remindersLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly confirmationRequired?: boolean;
            readonly sourceTool?: string;
            readonly certification?: {
              readonly schemaStatus: string;
              readonly schemaVersion?: string;
              readonly publicationGuarantee?: string;
              readonly publisher?: string;
              readonly provenance?: readonly string[];
              readonly receiptIds?: readonly string[];
              readonly missingSignals: readonly string[];
            };
            readonly freshness?: { readonly status: string; readonly source: string; readonly sourceTool?: string; readonly refreshRoute?: string; readonly sampleInput?: Record<string, unknown> };
            readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string; readonly policy: string }[];
          }[];
        }>(fixture, { mode: 'personal_ops_lane', laneId: 'reminders', includeParameters: true });
        expect(remindersLane.status).toBe('ready');
        expect(remindersLane.current).toContain('Fresh provider-backed reminder records');
        expect(remindersLane.next).toContain('published confirmed follow-up route');
        expect(remindersLane.signals).toContain('1 fresh provider-backed reminder record(s)');
        const reminderRecord = remindersLane.liveRecords?.find((record) => record.capability === 'reminder-provider-record');
        expect(reminderRecord?.label).toContain('Fresh reminder');
        expect(reminderRecord?.effect).toBe('read-only');
        expect(reminderRecord?.confirmationRequired).toBe(false);
        expect(reminderRecord?.sourceTool).toBe('context.platform.readModels.personalOps.reminders');
        expect(reminderRecord?.certification?.schemaStatus).toBe('legacy');
        expect(reminderRecord?.certification?.schemaVersion).toBe('goodvibes.personal-ops.reminder.v1');
        expect(reminderRecord?.certification?.publicationGuarantee).toContain('password=[REDACTED]');
        expect(reminderRecord?.certification?.publicationGuarantee).not.toContain('reminder-pub-secret');
        expect(reminderRecord?.certification?.publisher).toBe('goodvibes-daemon');
        expect(reminderRecord?.certification?.provenance?.join('\n')).toContain('reminders.list');
        expect(reminderRecord?.certification?.receiptIds).toEqual(['reminder-edit-receipt-1', 'reminder-snooze-receipt-1', 'reminder-delete-receipt-1']);
        expect(reminderRecord?.certification?.missingSignals).toEqual(['Native host or SDK reminder schema attestation is not published.']);
        expect(reminderRecord?.modelRoute).toContain('laneId:"reminders"');
        expect(reminderRecord?.summary).toContain('password=[REDACTED]');
        expect(reminderRecord?.summary).not.toContain('REMINDERSECRET');
        expect(reminderRecord?.freshness).toMatchObject({
          status: 'fresh-provider-record-current',
          source: 'daemon-read-model',
          sourceTool: 'context.platform.readModels.personalOps.reminders',
          sampleInput: { reminderId: 'reminder-report' },
        });
        expect(reminderRecord?.freshness?.refreshRoute).toBeUndefined();
        expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'edit-provider-reminder')?.requiresConfirmation).toBe(true);
        expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'snooze-provider-reminder')?.modelRoute).toContain('snooze_reminder');
        expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'delete-provider-reminder')?.policy).toContain('explicit confirmation');
        expect(remindersLane.liveRecords?.find((record) => record.id === 'reminder-create')).toBeDefined();
      }

      if (surface === 'briefing') {
        const briefing = await executeHarnessJson<{
          readonly steps: readonly { readonly id: string; readonly status: string; readonly evidence: readonly string[]; readonly sourceCounts: { readonly freshProviderReads?: number } }[];
        }>(fixture, { mode: 'personal_ops_briefing', includeParameters: true });
        const taskBrief = briefing.steps.find((step) => step.id === 'tasks');
        const reminderBrief = briefing.steps.find((step) => step.id === 'reminders');
        expect(taskBrief?.status).toBe('ready');
        expect(reminderBrief?.status).toBe('ready');
        expect(taskBrief?.evidence.join('\n')).toContain('1 fresh provider-backed task record(s)');
        expect(reminderBrief?.evidence.join('\n')).toContain('1 fresh provider-backed reminder record(s)');
        expect(taskBrief?.sourceCounts.freshProviderReads).toBe(1);
        expect(reminderBrief?.sourceCounts.freshProviderReads).toBe(1);
      }
    } finally {
      fixture.cleanup();
    }
  });


  test('surfaces Personal Ops provider-effect receipts as read-only lane evidence', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'gmail-send-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-provider-effect-receipt',
        laneId: 'inbox',
        providerId: 'gmail',
        operation: 'send-reply',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores provider-effect receipts after confirmed calls token=gmail-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method gmail.send_reply', 'sourceTool mcp:gmail:gmail.send_reply'],
        receiptId: 'gmail-send-1',
        threadId: 'thread-secret-token-123',
        sourceTool: 'mcp:gmail:gmail.send_reply',
        createdAt: '2026-06-08T13:00:00.000Z',
        redaction: 'metadata-only',
        nextRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'calendar-rsvp-receipt.json',
      text: '{"status":"failed"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'connected-host-personal-ops-effect-receipt',
        laneId: 'calendar',
        providerId: 'caldav',
        operation: 'rsvp',
        status: 'failed',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores provider-effect receipts after confirmed calls credential=caldav-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method calendar.rsvp', 'sourceTool mcp:calendar:calendar.rsvp'],
        receiptId: 'caldav-rsvp-1',
        eventId: 'evt-board-review',
        sourceTool: 'mcp:calendar:calendar.rsvp',
        failureReason: 'Provider rejected stale event tag',
        createdAt: '2026-06-08T13:05:00.000Z',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'task-complete-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-provider-effect-receipt',
        laneId: 'tasks',
        providerId: 'todoist',
        operation: 'complete',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores task receipts after confirmed calls secret=task-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method tasks.complete', 'sourceTool mcp:tasks:tasks.complete'],
        receiptId: 'todoist-complete-1',
        taskId: 'task-budget-review',
        sourceTool: 'mcp:tasks:tasks.complete',
        createdAt: '2026-06-08T13:08:00.000Z',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'reminder-snooze-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'connected-host-personal-ops-effect-receipt',
        laneId: 'reminders',
        providerId: 'caldav',
        operation: 'snooze',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores reminder receipts after confirmed calls password=reminder-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method reminders.snooze', 'sourceTool mcp:reminders:reminders.snooze'],
        receiptId: 'reminder-snooze-1',
        reminderId: 'reminder-report',
        sourceTool: 'mcp:reminders:reminders.snooze',
        createdAt: '2026-06-08T13:09:00.000Z',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const ops = await executeHarnessJson<{
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly artifactId?: string;
            readonly sourceTool?: string;
            readonly confirmationRequired?: boolean;
            readonly certification?: {
              readonly schemaStatus: string;
              readonly schemaVersion?: string;
              readonly publicationGuarantee?: string;
              readonly publisher?: string;
              readonly provenance?: readonly string[];
              readonly receiptId?: string;
              readonly missingSignals: readonly string[];
            };
            readonly followUpRoutes?: readonly {
              readonly id: string;
              readonly effect: string;
              readonly modelRoute: string;
              readonly requiresConfirmation: boolean;
              readonly policy: string;
            }[];
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const inboxReceipt = inbox?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-1');
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('provider-effect receipts');
      expect(inbox?.signals).toContain('1 saved inbox provider-effect receipt(s)');
      expect(inboxReceipt?.label).toContain('Inbox effect receipt');
      expect(inboxReceipt?.status).toBe('succeeded');
      expect(inboxReceipt?.summary).toContain('send-reply succeeded');
      expect(inboxReceipt?.summary).toContain('Provider gmail');
      expect(inboxReceipt?.summary).toContain('Subject thread-secret-token-123');
      expect(inboxReceipt?.summary).toContain('Redaction metadata-only');
      expect(inboxReceipt?.modelRoute).toBe('agent_artifacts show artifactId:"artifact-1" includeContent:false');
      expect(inboxReceipt?.tags).toContain('provider-effect-receipt');
      expect(inboxReceipt?.tags).toContain('send-reply');
      expect(inboxReceipt?.effect).toBe('read-only');
      expect(inboxReceipt?.capability).toBe('inbox-effect-receipt');
      expect(inboxReceipt?.artifactId).toBe('artifact-1');
      expect(inboxReceipt?.sourceTool).toBe('mcp:gmail:gmail.send_reply');
      expect(inboxReceipt?.confirmationRequired).toBe(false);
      expect(inboxReceipt?.certification?.schemaStatus).toBe('legacy');
      expect(inboxReceipt?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
      expect(inboxReceipt?.certification?.publicationGuarantee).not.toContain('gmail-receipt-secret');
      expect(inboxReceipt?.certification?.receiptId).toBe('gmail-send-1');
      expect(inboxReceipt?.certification?.missingSignals).toEqual(['Native host or SDK inbox provider-effect receipt schema attestation is not published.']);
      expect(inboxReceipt?.followUpRoutes?.find((route) => route.id === 'inspect-effect-receipt')?.requiresConfirmation).toBe(false);
      expect(inboxReceipt?.followUpRoutes?.find((route) => route.id === 'continue-provider-lane')?.modelRoute).toContain('laneId:"inbox"');

      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      const calendarReceipt = calendar?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-2');
      expect(calendar?.status).toBe('partial');
      expect(calendar?.current).toContain('provider-effect receipts');
      expect(calendar?.signals).toContain('1 saved calendar provider-effect receipt(s)');
      expect(calendarReceipt?.label).toContain('Calendar effect receipt');
      expect(calendarReceipt?.status).toBe('failed');
      expect(calendarReceipt?.summary).toContain('rsvp failed');
      expect(calendarReceipt?.summary).toContain('Provider caldav');
      expect(calendarReceipt?.summary).toContain('Subject evt-board-review');
      expect(calendarReceipt?.summary).toContain('Failure Provider rejected stale event tag');
      expect(calendarReceipt?.modelRoute).toBe('agent_artifacts show artifactId:"artifact-2" includeContent:false');
      expect(calendarReceipt?.tags).toContain('calendar-effect');
      expect(calendarReceipt?.tags).toContain('rsvp');
      expect(calendarReceipt?.effect).toBe('read-only');
      expect(calendarReceipt?.capability).toBe('calendar-effect-receipt');
      expect(calendarReceipt?.artifactId).toBe('artifact-2');
      expect(calendarReceipt?.sourceTool).toBe('mcp:calendar:calendar.rsvp');
      expect(calendarReceipt?.certification?.schemaStatus).toBe('legacy');
      expect(calendarReceipt?.certification?.publicationGuarantee).toContain('credential=[REDACTED]');
      expect(calendarReceipt?.certification?.publicationGuarantee).not.toContain('caldav-receipt-secret');
      expect(calendarReceipt?.certification?.receiptId).toBe('caldav-rsvp-1');
      expect(calendarReceipt?.certification?.missingSignals).toEqual(['Native host or SDK calendar provider-effect receipt schema attestation is not published.']);
      expect(calendarReceipt?.followUpRoutes?.find((route) => route.id === 'continue-provider-lane')?.modelRoute).toContain('laneId:"calendar"');

      const tasks = ops.lanes.find((lane) => lane.id === 'tasks');
      const taskReceipt = tasks?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-3');
      expect(tasks?.signals).toContain('1 saved task provider-effect receipt(s)');
      expect(taskReceipt?.label).toContain('Task effect receipt');
      expect(taskReceipt?.summary).toContain('complete succeeded');
      expect(taskReceipt?.capability).toBe('task-effect-receipt');
      expect(taskReceipt?.tags).toContain('tasks-effect');
      expect(taskReceipt?.sourceTool).toBe('mcp:tasks:tasks.complete');
      expect(taskReceipt?.certification?.schemaStatus).toBe('legacy');
      expect(taskReceipt?.certification?.publicationGuarantee).toContain('secret=[REDACTED]');
      expect(taskReceipt?.certification?.receiptId).toBe('todoist-complete-1');
      expect(taskReceipt?.certification?.missingSignals).toEqual(['Native host or SDK task provider-effect receipt schema attestation is not published.']);

      const reminders = ops.lanes.find((lane) => lane.id === 'reminders');
      const reminderReceipt = reminders?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-4');
      expect(reminders?.signals).toContain('1 saved reminder provider-effect receipt(s)');
      expect(reminderReceipt?.label).toContain('Reminder effect receipt');
      expect(reminderReceipt?.summary).toContain('snooze succeeded');
      expect(reminderReceipt?.capability).toBe('reminder-effect-receipt');
      expect(reminderReceipt?.tags).toContain('reminders-effect');
      expect(reminderReceipt?.sourceTool).toBe('mcp:reminders:reminders.snooze');
      expect(reminderReceipt?.certification?.schemaStatus).toBe('legacy');
      expect(reminderReceipt?.certification?.publicationGuarantee).toContain('password=[REDACTED]');
      expect(reminderReceipt?.certification?.receiptId).toBe('reminder-snooze-1');
      expect(reminderReceipt?.certification?.missingSignals).toEqual(['Native host or SDK reminder provider-effect receipt schema attestation is not published.']);
    } finally {
      fixture.cleanup();
    }
  });
});
