export type PersonalOpsLaneId =
  | 'inbox'
  | 'calendar'
  | 'notes'
  | 'tasks'
  | 'reminders'
  | 'routines'
  | 'delivery';

export type PersonalOpsStatus = 'ready' | 'partial' | 'needs-setup' | 'gap';
export type PersonalOpsWorkflowStatus = 'ready' | 'attention' | 'needs-setup';
export type PersonalOpsBriefingStatus = 'ready' | 'attention' | 'needs-setup';

export interface AgentHarnessPersonalOpsArgs {
  readonly laneId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly recordId?: unknown;
  readonly fields?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface OperatorContractMethod {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  /**
   * Capability-advertisement honesty: false means the method is
   * cataloged but NOT dispatchable (no route/handler serves it). Absent
   * means invokable (older contracts predate the flag).
   */
  readonly invokable?: boolean;
  readonly http?: {
    readonly method?: string;
    readonly path?: string;
  };
}

export interface PersonalOpsLane {
  readonly id: PersonalOpsLaneId;
  readonly label: string;
  readonly status: PersonalOpsStatus;
  readonly outcome: string;
  readonly current: string;
  readonly next: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly signals: readonly string[];
  readonly methodIds?: readonly string[];
  readonly connectorSignals?: readonly PersonalOpsConnectorSignal[];
  readonly liveRecords?: readonly PersonalOpsLiveRecord[];
  readonly workflows?: readonly PersonalOpsWorkflow[];
}

export interface PersonalOpsConnectorSignal {
  readonly id: string;
  readonly kind: 'mcp-server';
  readonly label: string;
  readonly status: 'ready' | 'attention';
  readonly summary: string;
  readonly modelRoute: string;
  readonly toolCount: number;
  readonly capabilityTags: readonly string[];
  readonly readTools?: readonly PersonalOpsConnectorTool[];
  readonly writeTools?: readonly PersonalOpsConnectorTool[];
}

export interface PersonalOpsConnectorTool {
  readonly name: string;
  readonly qualifiedName?: string;
  readonly description?: string;
  readonly effect: 'read-only' | 'confirmed-effect';
  readonly capability: string;
  readonly schemaRoute?: string;
  readonly requiredFields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly sampleInput?: Readonly<Record<string, unknown>>;
}

export interface PersonalOpsLiveRecord {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly summary: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly tags?: readonly string[];
  readonly effect?: 'read-only' | 'confirmed-effect';
  readonly capability?: string;
  readonly qualifiedName?: string;
  readonly requiredFields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly sampleInput?: Readonly<Record<string, unknown>>;
  readonly confirmationRequired?: boolean;
  readonly artifactId?: string;
  readonly reviewRecordCount?: number;
  readonly reviewLabels?: readonly string[];
  readonly sourceTool?: string;
  readonly certification?: PersonalOpsRecordCertification;
  readonly followUpRoutes?: readonly PersonalOpsFollowUpRoute[];
  readonly freshness?: PersonalOpsRecordFreshness;
}

export interface PersonalOpsRecordCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly receiptStatus?: string;
  readonly receiptRoute?: string;
  readonly receiptIds?: readonly string[];
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface PersonalOpsFollowUpRoute {
  readonly id: string;
  readonly label: string;
  readonly effect: 'read-only' | 'confirmed-effect';
  readonly modelRoute: string;
  readonly requiresConfirmation: boolean;
  readonly policy: string;
}

export interface PersonalOpsRoutePacket {
  readonly id: string;
  readonly label: string;
  readonly effect: 'read-only' | 'local-only' | 'confirmed-effect';
  readonly modelRoute: string;
  readonly requiresConfirmation: boolean;
  readonly policy: string;
}

export interface PersonalOpsRecordFreshness {
  readonly status:
    | 'fresh-provider-route-ready'
    | 'fresh-provider-record-current'
    | 'saved-review-refreshable'
    | 'connector-attention'
    | 'provider-contract-missing'
    | 'source-tool-missing';
  readonly source: 'connector-read' | 'saved-review-artifact' | 'daemon-read-model' | 'sdk-read-model';
  readonly sourceTool?: string;
  readonly lastReviewedAt?: string;
  readonly refreshRoute?: string;
  readonly requiredFields?: readonly string[];
  readonly sampleInput?: Readonly<Record<string, unknown>>;
  readonly policy: string;
}

export interface PersonalOpsWorkflow {
  readonly id: string;
  readonly label: string;
  readonly status: PersonalOpsWorkflowStatus;
  readonly summary: string;
  readonly next: string;
  readonly modelRoute: string;
  readonly inspectRoutes: readonly string[];
  readonly prerequisites: readonly string[];
  readonly runBoundary: string;
}

export interface McpToolRecord {
  readonly qualifiedName?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description?: string;
}

export interface McpToolSchema {
  readonly inputSchema?: unknown;
}

export interface McpSchemaSummary {
  readonly schemaRoute: string;
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly sampleInput: Readonly<Record<string, unknown>>;
}

export interface PersonalOpsIntakeCandidate {
  readonly id: string;
  readonly label: string;
  readonly laneId: PersonalOpsLaneId;
  readonly status: PersonalOpsWorkflowStatus;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoutes: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly safetyBoundary: string;
  readonly nextSteps: readonly string[];
  readonly workflowId?: string;
  readonly operation?: Record<string, unknown>;
  readonly followUpOperation?: Record<string, unknown>;
  readonly executionPlan?: readonly PersonalOpsExecutionStep[];
  readonly requiredFields?: readonly string[];
  readonly missingFields?: readonly string[];
  readonly userQuestion?: string;
}

export interface PersonalOpsExecutionStep {
  readonly id: string;
  readonly label: string;
  readonly routeKind: 'connector-read' | 'local-compose' | 'connector-confirmed-effect' | 'setup';
  readonly effect: 'read-only' | 'local-only' | 'confirmed-effect' | 'setup';
  readonly requiresConfirmation: boolean;
  readonly modelRoute: string;
  readonly status: PersonalOpsWorkflowStatus;
  readonly policy: string;
  readonly connectorId?: string;
  readonly connectorStatus?: PersonalOpsConnectorSignal['status'];
  readonly qualifiedName?: string;
  readonly schemaRoute?: string;
  readonly requiredFields?: readonly string[];
  readonly sampleInput?: Readonly<Record<string, unknown>>;
}

export type PersonalOpsLaneResolution =
  | { readonly status: 'found'; readonly lane: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export type PersonalOpsReadRunResult =
  | { readonly status: 'missing_lookup'; readonly usage: string; readonly examples: readonly string[] }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | Record<string, unknown>;

export const LANE_IDS: readonly PersonalOpsLaneId[] = ['inbox', 'calendar', 'notes', 'tasks', 'reminders', 'routines', 'delivery'];
export const PERSONAL_OPS_READ_CONTROL_FIELDS = new Set(['saveReviewCards', 'saveReview', 'artifactTitle']);
export const QUEUE_CAPABILITIES = new Set([
  'inbox-read',
  'calendar-read',
  'inbox-provider-thread',
  'calendar-provider-event',
  'inbox-thread-review',
  'calendar-event-review',
  'inbox-review-artifact',
  'calendar-review-artifact',
]);
