import type { BrowserKnowledgeKind, BrowserKnowledgeSourceKind } from '@goodvibes-jev/engine/sdk/platform/knowledge';

const BROWSER_KINDS = ['chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera', 'firefox', 'zen', 'librewolf', 'waterfox', 'floorp', 'safari', 'orion', 'epiphany'] as const satisfies readonly BrowserKnowledgeKind[];
const BROWSER_SOURCE_KINDS = ['history', 'bookmark'] as const satisfies readonly BrowserKnowledgeSourceKind[];

export function toBrowserKinds(values: readonly string[]): readonly BrowserKnowledgeKind[] {
  return values.filter((value): value is BrowserKnowledgeKind => BROWSER_KINDS.includes(value as BrowserKnowledgeKind));
}

export function toBrowserSourceKinds(values: readonly string[]): readonly BrowserKnowledgeSourceKind[] {
  return values.filter((value): value is BrowserKnowledgeSourceKind => BROWSER_SOURCE_KINDS.includes(value as BrowserKnowledgeSourceKind));
}
