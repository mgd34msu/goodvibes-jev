export type AgentToolArgs = {
  readonly mode?: unknown;
  readonly [key: string]: unknown;
};

export type ExecCommandArgs = {
  readonly cmd?: unknown;
  readonly background?: unknown;
  readonly until?: unknown;
  readonly [key: string]: unknown;
};

export type ExecToolArgs = {
  readonly commands?: unknown;
  readonly parallel?: unknown;
  readonly file_ops?: unknown;
  readonly [key: string]: unknown;
};

export type ModeToolArgs = {
  readonly mode?: unknown;
  readonly createIfMissing?: unknown;
  readonly [key: string]: unknown;
};

export type FetchToolArgs = {
  readonly urls?: unknown;
  readonly parallel?: unknown;
  readonly sanitize_mode?: unknown;
  readonly trusted_hosts?: unknown;
  readonly [key: string]: unknown;
};

export type StateToolArgs = {
  readonly mode?: unknown;
  readonly memoryAction?: unknown;
  readonly hookAction?: unknown;
  readonly modeAction?: unknown;
  readonly analyticsAction?: unknown;
  readonly values?: unknown;
  readonly clearKeys?: unknown;
  readonly memoryValue?: unknown;
  readonly hookDefinition?: unknown;
  readonly modeName?: unknown;
  readonly analyticsTool?: unknown;
  readonly analyticsArgs?: unknown;
  readonly analyticsResult?: unknown;
  readonly analyticsDuration?: unknown;
  readonly analyticsTokens?: unknown;
  readonly analyticsFormat?: unknown;
  readonly [key: string]: unknown;
};

export type InspectToolArgs = {
  readonly mode?: unknown;
  readonly dryRun?: unknown;
  readonly [key: string]: unknown;
};

export type AgentToolPolicyGuardOptions = {
  readonly getLastUserMessage?: () => string | null;
};

export type ModeRestrictedToolPolicy = {
  readonly allowedModes: readonly string[];
  readonly modeSet: ReadonlySet<string>;
  readonly description: string;
  readonly denial: string;
  readonly removedProperties?: readonly string[];
};

export interface AgentToolPolicyInvocationExplanation {
  readonly status: 'allowed' | 'denied';
  readonly layer: 'agent_tool_policy';
  readonly reason: string;
  readonly allowedModes?: readonly string[];
}
