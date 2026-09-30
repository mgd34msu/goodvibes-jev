import type { KnowledgeBatchIngestResult, KnowledgeSourceRecord } from '../types.js';

export type BrowserKnowledgeFamily = 'chromium' | 'gecko' | 'webkit';

export type BrowserKnowledgeKind =
  | 'chrome'
  | 'chromium'
  | 'brave'
  | 'edge'
  | 'vivaldi'
  | 'arc'
  | 'opera'
  | 'firefox'
  | 'zen'
  | 'librewolf'
  | 'waterfox'
  | 'floorp'
  | 'safari'
  | 'orion'
  | 'epiphany';

export type BrowserKnowledgeSourceKind = 'history' | 'bookmark';

export interface BrowserKnowledgeProfile {
  readonly family: BrowserKnowledgeFamily;
  readonly browser: BrowserKnowledgeKind;
  readonly profileName: string;
  readonly profilePath: string;
  readonly historyPath?: string | undefined;
  readonly bookmarksPath?: string | undefined;
}

export interface BrowserHistoryEntry {
  readonly sourceKind: 'history';
  readonly url: string;
  readonly title?: string | undefined;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly visitedAtMs?: number | undefined;
  readonly visitCount?: number | undefined;
  readonly transition?: string | undefined;
  readonly rawId?: string | number | undefined;
}

export interface BrowserBookmarkEntry {
  readonly sourceKind: 'bookmark';
  readonly url: string;
  readonly title?: string | undefined;
  readonly browser: BrowserKnowledgeKind;
  readonly family: BrowserKnowledgeFamily;
  readonly profileName: string;
  readonly profilePath: string;
  readonly folderPath?: string | undefined;
  readonly addedAtMs?: number | undefined;
  readonly rawId?: string | number | undefined;
}

export type BrowserKnowledgeEntry = BrowserHistoryEntry | BrowserBookmarkEntry;

export interface BrowserKnowledgeFilter {
  readonly browsers?: readonly BrowserKnowledgeKind[] | undefined;
  readonly sourceKinds?: readonly BrowserKnowledgeSourceKind[] | undefined;
  readonly homeOverride?: string | undefined;
  readonly limit?: number | undefined;
  readonly sinceMs?: number | undefined;
}

export interface BrowserKnowledgeCollectResult {
  readonly profiles: readonly BrowserKnowledgeProfile[];
  readonly entries: readonly BrowserKnowledgeEntry[];
  readonly errors: readonly string[];
}

/** Raw browser provenance capture and guarded graph compilation are separate phases. */
export interface BrowserKnowledgeIngestOutcome {
  readonly canonicalUri: string;
  /** Retained source identity, including when capture stopped after storing the source. */
  readonly sourceId?: string | undefined;
  readonly capture: 'completed' | 'partial' | 'failed';
  readonly compilation: 'completed' | 'held' | 'failed' | 'not-attempted';
  readonly error?: string | undefined;
}

/** Inherited imported/sources count only completed compilation; failed includes holds. */
export interface BrowserKnowledgeIngestResult extends KnowledgeBatchIngestResult {
  /** Aggregates with complete raw source, extraction and browser-profile provenance capture. */
  readonly captured: number;
  /** Complete captures, including those whose subsequent compilation was held or failed. */
  readonly capturedSources: readonly KnowledgeSourceRecord[];
  /** One outcome per canonical URL. Compilation completion does not assert fact acceptance. */
  readonly outcomes: readonly BrowserKnowledgeIngestOutcome[];
  readonly profiles: readonly BrowserKnowledgeProfile[];
}
