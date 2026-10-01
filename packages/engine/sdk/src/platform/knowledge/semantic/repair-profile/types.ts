export interface RepairProfileCategory {
  readonly title: string;
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
}
export interface RepairProfileValueCandidate {
  readonly reference: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
export interface RepairProfileSubject {
  readonly title: string;
  readonly kind?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly identity?: Readonly<Record<string, string>> | undefined;
}
export interface RepairProfileReadingInput {
  readonly query: string;
  readonly subjects: readonly RepairProfileSubject[];
  readonly source: { readonly title?: string | undefined; readonly sourceType: string; readonly url?: string | undefined;
    readonly sourceUri?: string | undefined; readonly canonicalUri?: string | undefined };
  readonly extraction?: { readonly format: string; readonly title?: string | undefined } | undefined;
  readonly text: string;
}
export interface RepairProfileSelection {
  readonly category: RepairProfileCategory;
  readonly values: readonly RepairProfileValueCandidate[];
}
export type RepairProfileHoldReason = 'foreign-space' | 'unconfigured' | 'unavailable' | 'unsettled' | 'no-support' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeRepairProfileHeldError extends Error {
  override readonly name = 'KnowledgeRepairProfileHeldError';
  constructor(readonly reason: RepairProfileHoldReason) {
    super(`Knowledge repair profile held (${reason}); no partial profile was authorized.`);
  }
}
export const REPAIR_PROFILE_LIMITS = Object.freeze({ inputs: 50, characters: 160_000, candidates: 100, requests: 2_000,
  bytes: 16_000_000, concurrency: 4, defaultTimeoutMs: 30_000, timeoutMs: 60_000 });
/** Presentation taxonomy, not detection rules. Every category and exact value is read. */
export const REPAIR_PROFILE_CATEGORIES: readonly RepairProfileCategory[] = Object.freeze([
  { title: 'Display and picture specifications', kind: 'specification', labels: ['display', 'picture'], aliases: ['display', 'picture', 'screen'] },
  { title: 'Input and output ports', kind: 'specification', labels: ['ports', 'connectivity'], aliases: ['ports', 'inputs', 'outputs', 'connectivity'] },
  { title: 'Smart TV platform and integrations', kind: 'feature', labels: ['smart-tv', 'apps'], aliases: ['smart tv', 'apps', 'platform'] },
  { title: 'Network and wireless capabilities', kind: 'capability', labels: ['network', 'wireless'], aliases: ['network', 'wireless', 'bluetooth', 'wi-fi'] },
  { title: 'Gaming and HDMI features', kind: 'feature', labels: ['gaming', 'hdmi'], aliases: ['gaming', 'game mode', 'hdmi 2.1'] },
  { title: 'Audio capabilities', kind: 'specification', labels: ['audio'], aliases: ['audio', 'speakers', 'sound'] },
  { title: 'Tuner and broadcast support', kind: 'specification', labels: ['tuner', 'broadcast'], aliases: ['tuner', 'broadcast', 'antenna'] },
]);
for (const category of REPAIR_PROFILE_CATEGORIES) {
  Object.freeze(category.labels); Object.freeze(category.aliases); Object.freeze(category);
}
