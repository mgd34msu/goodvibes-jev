import type { CommandContext } from '../input/command-registry.ts';

export type UiSurfaceKind = 'overlay' | 'modal' | 'workspace' | 'picker';

export interface AgentHarnessUiSurfaceArgs {
  readonly query?: unknown;
  readonly surfaceId?: unknown;
  readonly categoryId?: unknown;
  readonly category?: unknown;
  readonly target?: unknown;
  readonly key?: unknown;
  readonly prefix?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface UiSurfaceDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: UiSurfaceKind;
  readonly summary: string;
  readonly command: string;
  readonly preferredModelRoute: string;
  readonly parameters?: readonly string[];
  readonly available: (context: CommandContext) => boolean;
  readonly open: (context: CommandContext, args: AgentHarnessUiSurfaceArgs) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface UiSurfaceLookup {
  readonly source: 'surfaceId' | 'target' | 'query';
  readonly input: string;
  readonly resolvedBy: 'id' | 'case-insensitive-id' | 'label' | 'case-insensitive-label' | 'search';
}

export type UiSurfaceResolution =
  | {
    readonly status: 'found';
    readonly surface: UiSurfaceDefinition;
    readonly lookup: UiSurfaceLookup;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly Record<string, unknown>[];
  };
