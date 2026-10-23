import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { installAgentMcpCallRoute, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
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


  test.each(['ops', 'inboxIntake', 'draftIntake', 'calendarIntake', 'missingRead', 'unavailableRead', 'executedRead', 'briefing', 'compactBriefing', 'blockedWrite', 'lane', 'queue', 'compactQueue', 'compactQueueOwnerChange'] as const)('surfaces email and calendar MCP connectors as Personal Ops setup routes: %s', async surface => {
    // This real epoch millisecond passes Luhn: decimal filenames used to trip the PAN gate.
    setSystemTime(new Date(1_791_559_463_008));
    const artifactStore = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifactStore.store });
    try {
      const mcpApi = fixture.context.clients?.mcpApi as {
        listServerSecurity: () => readonly unknown[];
        listAllTools?: () => Promise<readonly {
          readonly qualifiedName?: string;
          readonly serverName: string;
          readonly toolName: string;
          readonly description?: string;
        }[]>;
        getToolSchema?: (qualifiedName: string) => Promise<{
          readonly inputSchema?: unknown;
        } | null>;
        callTool?: (qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
      };
      const mcpToolCalls: Array<{ readonly qualifiedName: string; readonly input: Readonly<Record<string, unknown>> }> = [];
      mcpApi.listServerSecurity = () => [
        {
          name: 'filesystem',
          connected: true,
          trustMode: 'constrained',
          role: 'tools',
          schemaFreshness: 'fresh',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [fixture.root],
          allowedHosts: ['localhost'],
        },
        {
          name: 'gmail-inbox',
          connected: true,
          trustMode: 'constrained',
          role: 'tools',
          schemaFreshness: 'fresh',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [],
          allowedHosts: ['mail.example.test'],
        },
        {
          name: 'caldav-agenda',
          connected: false,
          trustMode: 'ask-on-risk',
          role: 'tools',
          schemaFreshness: 'stale',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [],
          allowedHosts: ['calendar.example.test'],
        },
      ];
      mcpApi.listAllTools = async () => [
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.search_messages',
          serverName: 'gmail-inbox',
          toolName: 'gmail.search_messages',
          description: 'Search unread email messages and threads.',
        },
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.get_thread',
          serverName: 'gmail-inbox',
          toolName: 'gmail.get_thread',
          description: 'Read one email thread by id.',
        },
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.send_reply',
          serverName: 'gmail-inbox',
          toolName: 'gmail.send_reply',
          description: 'Send a reply to an email thread.',
        },
        {
          qualifiedName: 'mcp:caldav-agenda:caldav.list_events',
          serverName: 'caldav-agenda',
          toolName: 'caldav.list_events',
          description: 'List upcoming calendar events.',
        },
        {
          qualifiedName: 'mcp:caldav-agenda:caldav.update_event',
          serverName: 'caldav-agenda',
          toolName: 'caldav.update_event',
          description: 'Edit or reschedule a calendar event.',
        },
      ];
      mcpApi.getToolSchema = async (qualifiedName) => {
        if (qualifiedName === 'mcp:gmail-inbox:gmail.search_messages') {
          return {
            name: 'gmail.search_messages', annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                limit: { type: 'number' },
                mailbox: { type: 'string' },
                unreadOnly: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:gmail-inbox:gmail.get_thread') {
          return {
            name: 'gmail.get_thread', annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              required: ['threadId'],
              properties: {
                threadId: { type: 'string' },
                includeAttachments: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:gmail-inbox:gmail.send_reply') {
          return {
            name: 'gmail.send_reply', annotations: { readOnlyHint: false },
            inputSchema: {
              type: 'object',
              required: ['threadId', 'body'],
              properties: {
                threadId: { type: 'string' },
                body: { type: 'string' },
                dryRun: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:caldav-agenda:caldav.list_events') {
          return {
            name: 'caldav.list_events', annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              required: ['start', 'end'],
              properties: {
                start: { type: 'string' },
                end: { type: 'string' },
                calendarId: { type: 'string' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:caldav-agenda:caldav.update_event') {
          return {
            name: 'caldav.update_event', annotations: { readOnlyHint: false },
            inputSchema: {
              type: 'object',
              required: ['eventId'],
              properties: {
                eventId: { type: 'string' },
                title: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
              },
            },
          };
        }
        return null;
      };
      mcpApi.callTool = async (qualifiedName, input) => {
        mcpToolCalls.push({ qualifiedName, input });
        if (qualifiedName === 'mcp:gmail-inbox:gmail.search_messages') {
          return {
            content: [{
              type: 'text',
              text: 'Subject: Quarterly planning\nFrom: lead@example.test\nBody: unblock proposal review. token=SECRET123 password=hunter2',
            }],
            structuredContent: {
              messages: [{
                id: 'msg-1',
                threadId: 'thread-1',
                subject: 'Quarterly planning',
                from: 'lead@example.test',
                receivedAt: '2026-06-06T14:00:00Z',
                snippet: 'unblock proposal review token=SECRET123',
                'token=SYNTHETIC_KEY': 'provider key carried only through rawKeys',
              }],
            },
          };
        }
        throw new Error(`Unexpected MCP tool call: ${qualifiedName}`);
      };

      // Consumer controls use the declared saved-review contract. The executedRead
      // case separately exercises the actual confirmed MCP call and artifact writer.
      if (['briefing', 'compactBriefing', 'lane', 'queue', 'compactQueue', 'compactQueueOwnerChange'].includes(surface)) {
        const sourceTool = 'mcp:gmail-inbox:gmail.search_messages';
        const createdAt = new Date().toISOString();
        await artifactStore.store.create({ kind: 'data', mimeType: 'application/json', filename: 'Inbox-triage-cards-authored.json',
          text: JSON.stringify({ version: 1, createdAt, laneId: 'inbox', sourceRecordId: sourceTool, sourceTool,
            reviewRecords: [{ id: 'msg-1', kind: 'inbox-message', label: 'Quarterly planning',
              summary: 'from lead@example.test; unblock proposal review token=[REDACTED]', sourceTool,
              rawKeys: ['from', 'id', 'receivedAt', 'snippet', 'subject', 'token=[REDACTED]'],
              followUpBoundary: 'Sending requires a separate confirmed route.' }],
            outputPreview: 'Quarterly planning token=[REDACTED] password=[REDACTED]', outputTruncated: false,
            inputFieldKeys: ['limit', 'query', 'unreadOnly'],
            policy: 'Saved Personal Ops review-card artifacts contain redacted review cards and bounded previews only; full raw connector output and full input values are not stored.' }),
          metadata: { purpose: 'personal-ops-review-cards', createdAt, laneId: 'inbox', sourceRecordId: sourceTool, sourceTool,
            reviewRecordCount: 1, reviewLabels: ['Quarterly planning'], reviewKinds: ['inbox-message'], reviewRecordIds: ['msg-1'], fullRawConnectorOutputStored: false } });
      }

      if (surface === 'ops') {
        const ops = await executeHarnessJson<{
          readonly workflowSummary: { readonly ready: number; readonly attention: number };
          readonly lanes: readonly {
            readonly id: string;
            readonly status: string;
            readonly current: string;
            readonly modelRoute: string;
            readonly workflows?: readonly {
              readonly id: string;
              readonly status: string;
              readonly modelRoute: string;
              readonly inspectRoutes?: readonly string[];
              readonly prerequisites?: readonly string[];
              readonly runBoundary?: string;
            }[];
            readonly connectorSignals?: readonly {
              readonly id: string;
              readonly label: string;
              readonly status: string;
              readonly modelRoute: string;
              readonly toolCount: number;
              readonly capabilityTags?: readonly string[];
              readonly readTools?: readonly {
                readonly name: string;
                readonly qualifiedName?: string;
                readonly capability: string;
                readonly schemaRoute?: string;
                readonly requiredFields?: readonly string[];
                readonly sampleInput?: Record<string, unknown>;
              }[];
              readonly writeTools?: readonly {
                readonly name: string;
                readonly effect: string;
                readonly schemaRoute?: string;
                readonly requiredFields?: readonly string[];
                readonly sampleInput?: Record<string, unknown>;
              }[];
            }[];
            readonly liveRecords?: readonly {
              readonly id: string;
              readonly label?: string;
              readonly status: string;
              readonly modelRoute: string;
              readonly effect?: string;
              readonly capability?: string;
              readonly qualifiedName?: string;
              readonly requiredFields?: readonly string[];
              readonly sampleInput?: Record<string, unknown>;
              readonly confirmationRequired?: boolean;
              readonly freshness?: {
                readonly status: string;
                readonly source: string;
                readonly sourceTool?: string;
                readonly refreshRoute?: string;
                readonly requiredFields?: readonly string[];
                readonly sampleInput?: Record<string, unknown>;
              };
            }[];
          }[];
        }>(fixture, { mode: 'personal_ops', includeParameters: true });

        const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
        const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
        expect(ops.workflowSummary.ready).toBeGreaterThan(0);
        expect(ops.workflowSummary.attention).toBeGreaterThan(0);
        expect(inbox?.status).toBe('partial');
        expect(inbox?.current).toContain('MCP connector');
        expect(inbox?.modelRoute).toContain('mcp_servers');
        expect(inbox?.connectorSignals?.[0]?.id).toBe('mcp:gmail-inbox');
        expect(inbox?.connectorSignals?.[0]?.status).toBe('ready');
        expect(inbox?.connectorSignals?.[0]?.modelRoute).toContain('gmail-inbox');
        expect(inbox?.connectorSignals?.[0]?.toolCount).toBe(3);
        expect(inbox?.connectorSignals?.[0]?.capabilityTags).toEqual(['inbox-read', 'inbox-write']);
        expect(inbox?.connectorSignals?.[0]?.readTools?.map((tool) => tool.name)).toEqual(['gmail.get_thread', 'gmail.search_messages']);
        expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
        expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.schemaRoute).toContain('mcp:gmail-inbox:gmail.search_messages');
        expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.requiredFields).toEqual(['query']);
        expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.name).toBe('gmail.send_reply');
        expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.schemaRoute).toContain('mcp:gmail-inbox:gmail.send_reply');
        expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.requiredFields).toEqual(['body', 'threadId']);
        expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.sampleInput?.body).toBe('<reviewed draft text>');
        expect(inbox?.workflows?.[0]?.id).toBe('inbox-triage-briefing');
        expect(inbox?.workflows?.[0]?.status).toBe('ready');
        expect(inbox?.workflows?.[0]?.inspectRoutes?.[0]).toContain('gmail-inbox');
        expect(inbox?.workflows?.[0]?.prerequisites?.join('\n')).toContain('classified read-only inbox tool');
        expect(inbox?.workflows?.[1]?.runBoundary).toContain('sending');
        expect(inbox?.workflows?.[1]?.prerequisites?.join('\n')).toContain('write-like inbox tool');
        expect(inbox?.liveRecords?.some(record => record.id === 'mcp:gmail-inbox')).toBe(true);
        const inboxSearchRecord = inbox?.liveRecords?.find((record) => record.id === 'mcp:gmail-inbox:gmail.search_messages');
        expect(inboxSearchRecord?.label).toContain('Inbox read');
        expect(inboxSearchRecord?.modelRoute).toContain('mcp schema');
        expect(inboxSearchRecord?.effect).toBe('read-only');
        expect(inboxSearchRecord?.capability).toBe('inbox-read');
        expect(inboxSearchRecord?.requiredFields).toEqual(['query']);
        expect(inboxSearchRecord?.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(inboxSearchRecord?.confirmationRequired).toBe(false);
        expect(inboxSearchRecord?.freshness).toMatchObject({
          status: 'fresh-provider-route-ready',
          source: 'connector-read',
          sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
          requiredFields: ['query'],
        });
        expect(inboxSearchRecord?.freshness?.refreshRoute).toContain('personal_ops action:"read"');
        const inboxSendRecord = inbox?.liveRecords?.find((record) => record.id === 'mcp:gmail-inbox:gmail.send_reply');
        expect(inboxSendRecord?.effect).toBe('confirmed-effect');
        expect(inboxSendRecord?.confirmationRequired).toBe(true);
        expect(inboxSendRecord?.freshness).toBeUndefined();
        expect(inboxSendRecord?.sampleInput?.body).toBe('<reviewed draft text>');

        expect(calendar?.status).toBe('partial');
        expect(calendar?.connectorSignals?.[0]?.id).toBe('mcp:caldav-agenda');
        expect(calendar?.connectorSignals?.[0]?.status).toBe('attention');
        expect(calendar?.connectorSignals?.[0]?.capabilityTags).toEqual(['calendar-read', 'calendar-write']);
        expect(calendar?.connectorSignals?.[0]?.readTools?.[0]?.schemaRoute).toContain('mcp:caldav-agenda:caldav.list_events');
        expect(calendar?.connectorSignals?.[0]?.readTools?.[0]?.requiredFields).toEqual(['end', 'start']);
        expect(calendar?.workflows?.[0]?.status).toBe('attention');
        expect(calendar?.workflows?.[0]?.prerequisites?.join('\n')).toContain('trust/schema');
        const agendaRecord = calendar?.liveRecords?.find((record) => record.id === 'mcp:caldav-agenda:caldav.list_events');
        expect(agendaRecord?.modelRoute).toContain('mcp schema');
        expect(agendaRecord?.requiredFields).toEqual(['end', 'start']);
        expect(agendaRecord?.sampleInput?.start).toBe('<start-iso>');
        expect(agendaRecord?.freshness?.status).toBe('connector-attention');
        return;
      }

      if (surface === 'inboxIntake') {
        const inboxIntake = await executeHarnessJson<{
          readonly preferred: {
            readonly id: string;
            readonly laneId: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly requiresConfirmation: boolean;
            readonly requiredFields?: readonly string[];
            readonly missingFields?: readonly string[];
            readonly operation?: {
              readonly name: string;
              readonly qualifiedName?: string;
              readonly schemaRoute?: string;
              readonly sampleInput?: Record<string, unknown>;
            };
            readonly executionPlan?: readonly {
              readonly id: string;
              readonly routeKind: string;
              readonly effect: string;
              readonly requiresConfirmation: boolean;
              readonly qualifiedName?: string;
              readonly sampleInput?: Record<string, unknown>;
              readonly policy: string;
            }[];
            readonly nextSteps: readonly string[];
          };
          readonly laneRoute: string;
        }>(fixture, { mode: 'personal_ops_intake', query: 'Triage my unread email.', includeParameters: true });
        expect(inboxIntake.preferred.id).toBe('inbox-triage-briefing');
        expect(inboxIntake.preferred.laneId).toBe('inbox');
        expect(inboxIntake.preferred.status).toBe('ready');
        expect(inboxIntake.preferred.modelRoute).toContain('mcp:gmail-inbox:gmail.search_messages');
        expect(inboxIntake.preferred.requiresConfirmation).toBe(false);
        expect(inboxIntake.preferred.requiredFields).toEqual(['query']);
        expect(inboxIntake.preferred.missingFields).toEqual(['query']);
        expect(inboxIntake.preferred.operation?.name).toBe('gmail.search_messages');
        expect(inboxIntake.preferred.operation?.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(inboxIntake.preferred.executionPlan?.map((step) => step.routeKind)).toEqual(['connector-read', 'local-compose']);
        expect(inboxIntake.preferred.executionPlan?.[0]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
        expect(inboxIntake.preferred.executionPlan?.[0]?.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(inboxIntake.preferred.executionPlan?.[0]?.requiresConfirmation).toBe(false);
        expect(inboxIntake.preferred.executionPlan?.[1]?.effect).toBe('local-only');
        expect(inboxIntake.preferred.nextSteps.join('\n')).toContain('bounded read/list/search route');
        expect(inboxIntake.laneRoute).toContain('laneId:"inbox"');
        return;
      }

      if (surface === 'draftIntake') {
        const draftIntake = await executeHarnessJson<{
          readonly preferred: {
            readonly id: string;
            readonly operation?: { readonly name: string; readonly qualifiedName?: string };
            readonly followUpOperation?: { readonly name: string; readonly confirmationRequired?: boolean };
            readonly executionPlan?: readonly {
              readonly id: string;
              readonly routeKind: string;
              readonly effect: string;
              readonly requiresConfirmation: boolean;
              readonly qualifiedName?: string;
              readonly policy: string;
            }[];
            readonly nextSteps: readonly string[];
          };
        }>(fixture, { mode: 'personal_ops_intake', query: 'Draft a reply to this email thread.', includeParameters: true });
        expect(draftIntake.preferred.id).toBe('inbox-draft-reply');
        expect(draftIntake.preferred.operation?.name).toBe('gmail.get_thread');
        expect(draftIntake.preferred.followUpOperation?.name).toBe('gmail.send_reply');
        expect(draftIntake.preferred.followUpOperation?.confirmationRequired).toBe(true);
        expect(draftIntake.preferred.executionPlan?.map((step) => step.routeKind)).toEqual(['connector-read', 'local-compose', 'connector-confirmed-effect']);
        expect(draftIntake.preferred.executionPlan?.[2]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.send_reply');
        expect(draftIntake.preferred.executionPlan?.[2]?.requiresConfirmation).toBe(true);
        expect(draftIntake.preferred.executionPlan?.[2]?.policy).toContain('explicitly confirms');
        expect(draftIntake.preferred.nextSteps.join('\n')).toContain('separate confirmed connector action');
        return;
      }

      if (surface === 'calendarIntake') {
        const calendarIntake = await executeHarnessJson<{
          readonly preferred: {
            readonly id: string;
            readonly laneId: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly missingFields?: readonly string[];
            readonly operation?: { readonly name: string; readonly connectorStatus?: string };
            readonly executionPlan?: readonly { readonly id: string; readonly routeKind: string; readonly status: string; readonly policy: string }[];
            readonly nextSteps: readonly string[];
          };
        }>(fixture, { mode: 'personal_ops_intake', query: 'Brief my calendar for today.', includeParameters: true });
        expect(calendarIntake.preferred.id).toBe('calendar-agenda-briefing');
        expect(calendarIntake.preferred.laneId).toBe('calendar');
        expect(calendarIntake.preferred.status).toBe('attention');
        expect(calendarIntake.preferred.modelRoute).toContain('mcp:caldav-agenda:caldav.list_events');
        expect(calendarIntake.preferred.missingFields).toEqual(['connector trust/schema freshness']);
        expect(calendarIntake.preferred.operation?.connectorStatus).toBe('attention');
        expect(calendarIntake.preferred.executionPlan?.[0]?.id).toBe('repair-connector-readiness');
        expect(calendarIntake.preferred.executionPlan?.[0]?.routeKind).toBe('setup');
        expect(calendarIntake.preferred.executionPlan?.[0]?.policy).toContain('schema freshness');
        expect(calendarIntake.preferred.nextSteps.join('\n')).toContain('Repair connector trust');
        return;
      }

      if (surface === 'missingRead') {
        const missingRead = await executeHarnessJson<{
          readonly status: string;
          readonly missingFields?: readonly string[];
          readonly sampleInput?: Record<string, unknown>;
          readonly runRoute?: string;
        }>(fixture, {
          mode: 'run_personal_ops_read',
          laneId: 'inbox',
          recordId: 'mcp:gmail-inbox:gmail.search_messages',
          includeParameters: true,
        });
        expect(missingRead.status).toBe('missing_fields');
        expect(missingRead.missingFields).toEqual(['query']);
        expect(missingRead.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(missingRead.runRoute).toContain('personal_ops action:"read"');
        expect(mcpToolCalls).toHaveLength(0);
        return;
      }

      if (surface === 'unavailableRead') {
        const unavailableRead = await executeHarnessJson<{
          readonly status: string;
          readonly reason?: string;
        }>(fixture, {
          mode: 'run_personal_ops_read',
          laneId: 'inbox',
          recordId: 'mcp:gmail-inbox:gmail.search_messages',
          fields: { query: 'is:unread newer_than:7d' },
        });
        expect(unavailableRead.status).toBe('unavailable');
        expect(unavailableRead.reason).toBe('admitted_mcp_call_route_unavailable');
        expect(mcpToolCalls).toHaveLength(0);
        return;
      }

      if (surface === 'executedRead') {
        const store = new ArtifactStore({ rootDir: join(fixture.root, 'native-read-artifacts') });
        Object.assign(fixture.context.platform, { artifactStore: store });
        fixture.toolRegistry.register({ definition: { name: 'mcp', description: 'Inspect the isolated MCP fixture and use its installed native call route.',
          parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['tools', 'schema'] }, qualifiedName: { type: 'string' } },
            required: ['mode'], additionalProperties: false } },
          execute: async () => ({ success: false, error: 'This fixture requires the installed native MCP call route.' }) });
        expect(installAgentMcpCallRoute(fixture.toolRegistry, fixture.context)).toBe(true);
        const executedRead = await executeHarnessJson<{
          readonly status: string;
          readonly error?: string;
          readonly record?: { readonly qualifiedName?: string };
          readonly input?: Record<string, unknown>;
          readonly output?: { readonly preview: string; readonly truncated: boolean; readonly redaction: string };
          readonly reviewSummary?: { readonly kind: string; readonly records: number; readonly source: string };
          readonly reviewRecords?: readonly {
            readonly id: string;
            readonly kind: string;
            readonly label: string;
            readonly summary: string;
            readonly sourceTool?: string;
            readonly followUpBoundary: string;
          }[];
          readonly savedReviewArtifact?: {
            readonly status: string;
            readonly artifactId?: string;
            readonly modelRoute?: string;
            readonly policy?: string;
          };
          readonly nextRoutes?: {
            readonly lane?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly queue?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly refresh?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly artifact?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly savedQueue?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly localDraft?: { readonly effect: string; readonly modelRoute: string; readonly requiresConfirmation: boolean };
            readonly sendBoundary?: { readonly modelRoute: string; readonly requiresConfirmation: boolean; readonly policy: string };
          };
          readonly followUp?: readonly string[];
        }>(fixture, {
          mode: 'run_personal_ops_read',
          laneId: 'inbox',
          recordId: 'mcp:gmail-inbox:gmail.search_messages',
          fields: {
            query: 'is:unread newer_than:7d',
            limit: '2',
            unreadOnly: 'true',
            saveReviewCards: 'true',
            artifactTitle: 'Inbox triage cards',
          },
          confirm: true,
          explicitUserRequest: 'Triage my unread inbox.',
          includeParameters: true,
        });
        expect(executedRead.status, executedRead.error).toBe('executed');
        const artifactId = store.list()[0]?.id;
        if (!artifactId) throw new Error('Expected actual saved native review artifact');
        expect(executedRead.record?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
        expect(executedRead.input?.limit).toBe(2);
        expect(executedRead.input?.unreadOnly).toBe(true);
        expect(executedRead.output?.preview).toContain('Quarterly planning');
        expect(executedRead.output?.preview).toContain('token=[REDACTED]');
        expect(executedRead.output?.preview).toContain('password=[REDACTED]');
        expect(executedRead.output?.preview).not.toContain('SECRET123');
        expect(executedRead.reviewSummary).toEqual({
          kind: 'inbox',
          records: 1,
          source: 'mcp:gmail-inbox:gmail.search_messages',
        });
        expect(executedRead.reviewRecords?.[0]?.id).toBe('msg-1');
        expect(executedRead.reviewRecords?.[0]?.kind).toBe('inbox-message');
        expect(executedRead.reviewRecords?.[0]?.label).toBe('Quarterly planning');
        expect(executedRead.reviewRecords?.[0]?.summary).toContain('from lead@example.test');
        expect(executedRead.reviewRecords?.[0]?.summary).toContain('token=[REDACTED]');
        expect(executedRead.reviewRecords?.[0]?.summary).not.toContain('SECRET123');
        expect(executedRead.reviewRecords?.[0]?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
        expect(executedRead.reviewRecords?.[0]?.followUpBoundary).toContain('separate confirmed route');
        expect(executedRead.savedReviewArtifact?.status).toBe('saved');
        expect(executedRead.savedReviewArtifact?.artifactId).toBe(artifactId);
        expect(store.get(artifactId)?.filename).toMatch(/^Inbox-triage-cards-[a-p]{32}\.json$/);
        expect(store.get(artifactId)?.filename).not.toContain(String(Date.now()));
        const savedReview = await store.readContent(artifactId);
        const savedReviewText = savedReview.buffer.toString('utf8');
        const savedPayload = JSON.parse(savedReviewText) as {
          readonly createdAt: string;
          readonly outputPreview: string;
          readonly inputFieldKeys: readonly string[];
          readonly reviewRecords: readonly { readonly summary: string; readonly rawKeys: readonly string[] }[];
        };
        expect(savedPayload.createdAt).toBe('2026-10-09T15:24:23.008Z');
        expect(savedPayload.outputPreview).toContain('password=[REDACTED]');
        expect(savedPayload.reviewRecords[0]?.summary).toContain('token=[REDACTED]');
        expect(savedPayload.reviewRecords[0]?.rawKeys).toContain('subject');
        expect(savedPayload.reviewRecords[0]?.rawKeys).toContain('token=[REDACTED]');
        expect(savedReviewText).not.toContain('SYNTHETIC_KEY');
        expect(savedPayload.inputFieldKeys).toContain('query');
        expect(savedReviewText).not.toContain('SECRET123');
        expect(savedReviewText).not.toContain('hunter2');
        expect(executedRead.savedReviewArtifact?.modelRoute).toContain('agent_artifacts');
        expect(executedRead.savedReviewArtifact?.policy).toContain('redacted review cards');
        expect(executedRead.nextRoutes?.lane?.modelRoute).toBe('personal_ops action:"lane" laneId:"inbox" includeParameters:true');
        expect(executedRead.nextRoutes?.lane?.requiresConfirmation).toBe(false);
        expect(executedRead.nextRoutes?.queue?.modelRoute).toBe('personal_ops action:"queue" query:"inbox" includeParameters:true');
        expect(executedRead.nextRoutes?.refresh?.modelRoute).toContain('personal_ops action:"read"');
        expect(executedRead.nextRoutes?.refresh?.modelRoute).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
        expect(executedRead.nextRoutes?.refresh?.requiresConfirmation).toBe(true);
        expect(executedRead.nextRoutes?.artifact?.modelRoute).toBe(`agent_artifacts show artifactId:"${artifactId}" includeContent:true`);
        expect(executedRead.nextRoutes?.artifact?.requiresConfirmation).toBe(false);
        expect(executedRead.nextRoutes?.savedQueue?.modelRoute).toBe(`personal_ops action:"queue" query:"${artifactId}" includeParameters:true`);
        expect(executedRead.nextRoutes?.localDraft?.effect).toBe('local-only');
        expect(executedRead.nextRoutes?.localDraft?.modelRoute).toContain(artifactId);
        expect(executedRead.nextRoutes?.localDraft?.requiresConfirmation).toBe(false);
        expect(executedRead.nextRoutes?.sendBoundary?.modelRoute).toContain('personal_ops action:"intake"');
        expect(executedRead.nextRoutes?.sendBoundary?.requiresConfirmation).toBe(true);
        expect(executedRead.nextRoutes?.sendBoundary?.policy).toContain('exact recipients and body');
        expect(executedRead.followUp?.join('\n')).toContain('separate current recorded effect admission');
        expect(mcpToolCalls).toEqual([{
          qualifiedName: 'mcp:gmail-inbox:gmail.search_messages',
          input: { query: 'is:unread newer_than:7d', limit: 2, unreadOnly: true },
        }]);
        expect(store.list()).toHaveLength(1);
        expect(store.list()[0]?.metadata).toMatchObject({
          purpose: 'personal-ops-review-cards',
          laneId: 'inbox',
          sourceRecordId: 'mcp:gmail-inbox:gmail.search_messages',
          sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
          reviewRecordCount: 1,
          reviewLabels: ['Quarterly planning'],
          reviewKinds: ['inbox-message'],
          reviewRecordIds: ['msg-1'],
          fullRawConnectorOutputStored: false,
        });
        const savedArtifact = await store.readContent(artifactId);
        const savedText = savedArtifact.buffer.toString('utf-8');
        expect(savedText).toContain('"reviewRecords"');
        expect(savedText).toContain('Quarterly planning');
        expect(savedText).toContain('token=[REDACTED]');
        expect(savedText).not.toContain('SECRET123');
        expect(savedText).toContain('"inputFieldKeys"');
        expect(savedText).not.toContain('is:unread newer_than:7d');
        return;
      }

      if (surface === 'briefing') {
        const briefing = await executeHarnessJson<{
          readonly status: string;
          readonly title: string;
          readonly readiness: { readonly ready: number; readonly attention: number; readonly 'needs-setup': number };
          readonly steps: readonly {
            readonly id: string;
            readonly status: string;
            readonly next: string;
            readonly modelRoute: string;
            readonly inspectRoutes: readonly string[];
            readonly evidence: readonly string[];
            readonly sourceCounts: {
              readonly refreshableSavedRecords?: number;
              readonly freshProviderReads?: number;
              readonly attentionWorkflows?: number;
            };
            readonly confirmationBoundary: string;
          }[];
          readonly routes?: { readonly liveReadTemplate?: string; readonly autonomyQueue?: string };
          readonly missingContracts?: readonly string[];
          readonly policy?: string;
        }>(fixture, {
          mode: 'personal_ops_briefing',
          query: 'Build my daily personal ops brief.',
          includeParameters: true,
        });
        expect(briefing.status).toBe('attention');
        expect(briefing.title).toContain('Daily Personal Ops');
        expect(briefing.readiness.ready).toBeGreaterThan(0);
        expect(briefing.readiness.attention).toBeGreaterThan(0);
        expect(briefing.routes?.liveReadTemplate).toContain('personal_ops action:"read"');
        expect(briefing.routes?.autonomyQueue).toBe('autonomy action:"queue"');
        expect(briefing.policy).toContain('read-only');
        expect(briefing.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
          'inbox',
          'calendar',
          'tasks',
          'reminders',
          'delivery',
          'notes',
          'autonomy-queue',
        ]));
        const inboxBrief = briefing.steps.find((step) => step.id === 'inbox');
        expect(inboxBrief?.status).toBe('attention');
        expect(inboxBrief?.modelRoute).toContain('personal_ops action:"lane"');
        expect(inboxBrief?.inspectRoutes.join('\n')).toContain('laneId:"inbox"');
        expect(inboxBrief?.evidence.join('\n')).toContain('1 refreshable saved inbox queue item(s)');
        expect(inboxBrief?.sourceCounts.refreshableSavedRecords).toBeGreaterThan(0);
        expect(inboxBrief?.sourceCounts.freshProviderReads).toBeGreaterThan(0);
        expect(inboxBrief?.confirmationBoundary).toContain('separate confirmed route');
        const calendarBrief = briefing.steps.find((step) => step.id === 'calendar');
        expect(calendarBrief?.status).toBe('attention');
        expect(calendarBrief?.next).toContain('Repair connector trust');
        expect(calendarBrief?.sourceCounts.attentionWorkflows).toBeGreaterThan(0);
        const autonomyBrief = briefing.steps.find((step) => step.id === 'autonomy-queue');
        expect(autonomyBrief?.status).toBe('ready');
        expect(autonomyBrief?.confirmationBoundary).toContain('separate confirmed route');
        expect(briefing.missingContracts?.join('\n')).toContain('Calendar');
        return;
      }

      if (surface === 'compactBriefing') {
        const compactBriefing = await executeHarnessJson<{
          readonly steps: readonly { readonly id: string; readonly evidence: readonly string[] }[];
        }>(fixture, { mode: 'personal_ops_briefing' });
        expect(compactBriefing.steps.find((step) => step.id === 'inbox')?.evidence.join('\n')).toContain('1 email-like MCP connector(s)');
        expect(compactBriefing.steps.find((step) => step.id === 'calendar')?.evidence.join('\n')).toContain('1 calendar-like MCP connector(s)');
        return;
      }

      if (surface === 'blockedWrite') {
        const blockedWrite = await executeHarnessJson<{
          readonly status: string;
          readonly reason?: string;
          readonly policy?: string;
        }>(fixture, {
          mode: 'run_personal_ops_read',
          laneId: 'inbox',
          recordId: 'mcp:gmail-inbox:gmail.send_reply',
          fields: { threadId: 'thread-1', body: 'Reviewed reply.' },
          confirm: true,
          explicitUserRequest: 'Send the reviewed reply.',
        });
        expect(blockedWrite.status).toBe('blocked');
        expect(blockedWrite.reason).toBe('not_read_only');
        expect(blockedWrite.policy).toContain('refuses send');
        expect(mcpToolCalls).toHaveLength(0);
        return;
      }

      if (surface === 'lane') {
        const lane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly signals: readonly string[];
          readonly connectorSignals?: readonly { readonly id: string; readonly modelRoute: string; readonly readTools?: readonly { readonly name: string }[] }[];
          readonly workflows?: readonly { readonly id: string; readonly inspectRoutes?: readonly string[]; readonly prerequisites?: readonly string[] }[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly modelRoute: string;
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
              readonly requiredFields?: readonly string[];
              readonly sampleInput?: Record<string, unknown>;
              readonly policy?: string;
            };
            readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string }[];
          }[];
        }>(fixture, { mode: 'personal_ops_lane', laneId: 'inbox', includeParameters: true });
        expect(lane.id).toBe('inbox');
        expect(lane.status).toBe('partial');
        expect(lane.signals).toContain('1 refreshable saved inbox queue item(s)');
        const savedThreadRecord = lane.liveRecords?.find((record) => record.id === 'review-thread:artifact-1:msg-1');
        expect(savedThreadRecord?.label).toContain('Saved thread');
        expect(savedThreadRecord?.capability).toBe('inbox-thread-review');
        expect(savedThreadRecord?.freshness).toMatchObject({
          status: 'saved-review-refreshable',
          source: 'saved-review-artifact',
          sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
          requiredFields: ['query'],
        });
        expect(savedThreadRecord?.freshness?.refreshRoute).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
        expect(savedThreadRecord?.freshness?.sampleInput?.query).toBe('is:unread newer_than:7d');
        expect(savedThreadRecord?.followUpRoutes?.find((route) => route.id === 'refresh-saved-thread')?.requiresConfirmation).toBe(true);
        expect(savedThreadRecord?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
        const savedReviewRecord = lane.liveRecords?.find((record) => record.id === 'review-artifact:artifact-1');
        expect(savedReviewRecord?.label).toContain('Saved inbox review');
        expect(savedReviewRecord?.modelRoute).toContain('artifact-1');
        expect(savedReviewRecord?.effect).toBe('read-only');
        expect(savedReviewRecord?.capability).toBe('inbox-review-artifact');
        expect(savedReviewRecord?.artifactId).toBe('artifact-1');
        expect(savedReviewRecord?.reviewRecordCount).toBe(1);
        expect(savedReviewRecord?.reviewLabels).toEqual(['Quarterly planning']);
        expect(savedReviewRecord?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
        expect(savedReviewRecord?.freshness?.status).toBe('saved-review-refreshable');
        expect(lane.connectorSignals?.[0]?.modelRoute).toContain('mcp_server');
        expect(lane.connectorSignals?.[0]?.readTools?.[0]?.name).toBe('gmail.get_thread');
        expect(lane.workflows?.[0]?.inspectRoutes?.[0]).toContain('gmail-inbox');
        expect(lane.workflows?.[0]?.prerequisites?.join('\n')).toContain('classified read-only inbox tool');
        return;
      }

      if (surface === 'queue') {
        const queue = await executeHarnessJson<{
          readonly status: string;
          readonly returned: number;
          readonly total: number;
          readonly summary: {
            readonly inbox: number;
            readonly calendar: number;
            readonly freshProviderReads: number;
            readonly refreshableSavedRecords: number;
            readonly savedReviewRecords: number;
            readonly attentionRecords: number;
            readonly confirmedFollowUps: number;
          };
          readonly queue: readonly {
            readonly queueItemId: string;
            readonly laneId: string;
            readonly type: string;
            readonly capability?: string;
            readonly freshness?: {
              readonly status: string;
              readonly refreshRoute?: string;
              readonly refreshRequiresConfirmation?: boolean;
            };
            readonly routes: {
              readonly lane: string;
              readonly inspect: string;
              readonly refresh?: string;
              readonly artifact?: string;
            };
            readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string }[];
          }[];
          readonly routes: { readonly liveReadTemplate: string };
          readonly policy: string;
        }>(fixture, { mode: 'personal_ops_queue', includeParameters: true });
        expect(queue.status).toBe('attention');
        expect(queue.total).toBeGreaterThanOrEqual(5);
        expect(queue.returned).toBe(queue.queue.length);
        expect(queue.summary.inbox).toBeGreaterThan(0);
        expect(queue.summary.calendar).toBeGreaterThan(0);
        expect(queue.summary.freshProviderReads).toBeGreaterThan(0);
        expect(queue.summary.refreshableSavedRecords).toBeGreaterThan(0);
        expect(queue.summary.savedReviewRecords).toBeGreaterThan(0);
        expect(queue.summary.attentionRecords).toBeGreaterThan(0);
        expect(queue.summary.confirmedFollowUps).toBeGreaterThan(0);
        expect(queue.routes.liveReadTemplate).toContain('personal_ops action:"read"');
        expect(queue.policy).toContain('read-only');
        const queueThread = queue.queue.find((record) => record.queueItemId === 'inbox:review-thread:artifact-1:msg-1');
        expect(queueThread?.type).toBe('saved-inbox-thread');
        expect(queueThread?.freshness?.status).toBe('saved-review-refreshable');
        expect(queueThread?.freshness?.refreshRequiresConfirmation).toBe(true);
        expect(queueThread?.routes.refresh).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
        expect(queueThread?.routes.artifact).toContain('artifact-1');
        expect(queueThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
        const providerRead = queue.queue.find((record) => record.type === 'fresh-provider-read' && record.capability === 'inbox-read');
        expect(providerRead?.freshness?.status).toBe('fresh-provider-route-ready');
        expect(providerRead?.routes.lane).toBe('personal_ops action:"lane" laneId:"inbox"');
        return;
      }

      if (surface === 'compactQueueOwnerChange') {
        const ordinary = createHarnessFixtureReadings();
        let reached = false;
        installJudgmentPort(withDecisionLog({ model: ordinary.model, async ask(request) {
          const result = await ordinary.ask(request);
          if (request.context?.site === 'agent.personal-ops.queue') {
            reached = true;
            Object.assign(fixture.context.platform, { artifactStore: createHarnessArtifactStore().store });
          }
          return result;
        } }, fixtureLog));
        await expect(fixture.tool.execute({ mode: 'personal_ops_queue', query: 'review-thread:artifact-1:msg-1', limit: 1 })).rejects.toThrow();
        expect(reached).toBe(true);
        return;
      }

      if (surface === 'compactQueue') {
        const compactQueue = await executeHarnessJson<{
          readonly queue: readonly { readonly queueItemId: string }[];
          readonly total: number;
        }>(fixture, { mode: 'personal_ops_queue', query: 'review-thread:artifact-1:msg-1', limit: 1 });
        expect(compactQueue.total).toBe(1);
        expect(compactQueue.queue).toHaveLength(1);
        expect(compactQueue.queue[0]?.queueItemId).toBe('inbox:review-thread:artifact-1:msg-1');
        return;
      }
    } finally {
      setSystemTime();
      fixture.cleanup();
    }
  });
});
