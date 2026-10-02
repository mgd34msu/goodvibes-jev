export type GoodVibesCliCommand =
  | 'tui'
  | 'run'
  | 'status'
  | 'doctor'
  | 'onboarding'
  | 'models'
  | 'providers'
  | 'profiles'
  | 'personas'
  | 'skills'
  | 'memory'
  | 'routines'
  | 'ci'
  | 'principals'
  | 'owner-profile'
  | 'channel-profiles'
  | 'workspaces'
  | 'browser'
  | 'fleet'
  | 'auth'
  | 'compat'
  | 'knowledge'
  | 'ask'
  | 'search'
  | 'delegate'
  | 'subscription'
  | 'secrets'
  | 'sessions'
  | 'tasks'
  | 'relay'
  | 'pair'
  | 'bundle'
  | 'import'
  | 'completion'
  | 'help'
  | 'version'
  | 'unknown';

export type GoodVibesCliOutputFormat = 'text' | 'json' | 'stream-json';

export interface CliCommandOutput {
  readonly output: string;
  readonly exitCode: number;
}

export interface GoodVibesCliFlags {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly agentProfile: string | undefined;
  readonly runtimeUrl: string | undefined;
  readonly workingDir: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly prompt: string | undefined;
  readonly print: boolean;
  readonly outputFormat: GoodVibesCliOutputFormat;
  readonly configOverrides: readonly string[];
  readonly enableFeatures: readonly string[];
  readonly disableFeatures: readonly string[];
  readonly noAltScreen: boolean;
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly open: boolean;
  readonly continueLast: boolean;
  readonly resume: string | undefined;
  readonly session: string | undefined;
  readonly fork: boolean;
  readonly rawOutput: boolean;
  readonly acceptRawOutputRisk: boolean;
}

export interface GoodVibesCliParseResult {
  readonly binary: string;
  readonly command: GoodVibesCliCommand;
  readonly rawCommand: string | undefined;
  readonly commandArgs: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: GoodVibesCliFlags;
  readonly errors: readonly string[];
}
