import type {
  AgentWorkspaceActionResult,
  AgentWorkspaceActionSearchResult,
  AgentWorkspaceCategory,
  AgentWorkspaceFocusPane,
} from './agent-workspace-types.ts';

export interface AgentWorkspaceSearchHost {
  readonly categories: readonly AgentWorkspaceCategory[];
  readonly selectedCategory: AgentWorkspaceCategory;
  actionSearchActive: boolean;
  actionSearchQuery: string;
  focusPane: AgentWorkspaceFocusPane;
  selectedCategoryIndex: number;
  selectedActionIndex: number;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  focusActions(): void;
  clampSelection(): void;
}

export function searchAgentWorkspaceActions(
  categories: readonly AgentWorkspaceCategory[],
  query: string,
): readonly AgentWorkspaceActionSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const results: Array<{ readonly result: AgentWorkspaceActionSearchResult; readonly score: number }> = [];
  categories.forEach((category, categoryIndex) => {
    category.actions.forEach((action, actionIndex) => {
      const haystack = [
        category.id,
        category.label,
        category.summary,
        category.detail,
        action.id,
        action.label,
        action.detail,
        action.command ?? '',
        action.editorKind ?? '',
        action.targetCategoryId ?? '',
        action.modelPickerFlow ?? '',
        action.modelPickerTarget ?? '',
        action.settingsTarget ?? '',
        action.localOperation ?? '',
        action.safety,
      ].join(' ').toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        const result = { category, categoryIndex, action, actionIndex };
        results.push({ result, score: scoreActionSearchResult(result, normalized, terms) });
      }
    });
  });
  return results
    .sort((left, right) => right.score - left.score || left.result.categoryIndex - right.result.categoryIndex || left.result.actionIndex - right.result.actionIndex)
    .map((entry) => entry.result);
}

function scoreField(value: string | undefined, terms: readonly string[], exactQuery: string, exactWeight: number, termWeight: number): number {
  const normalized = (value ?? '').toLowerCase();
  if (!normalized) return 0;
  const bareNormalized = normalized.replace(/^\//, '');
  let score = bareNormalized === exactQuery || normalized === exactQuery
    ? exactWeight
    : exactQuery.includes(' ') && normalized.includes(exactQuery)
      ? exactWeight
      : 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += termWeight;
  }
  return score;
}

function scoreActionSearchResult(
  result: AgentWorkspaceActionSearchResult,
  exactQuery: string,
  terms: readonly string[],
): number {
  const { category, action } = result;
  let score = 0;
  score += scoreField(action.id, terms, exactQuery, 90, 28);
  score += scoreField(action.editorKind, terms, exactQuery, 85, 26);
  score += scoreField(action.command, terms, exactQuery, 75, 22);
  score += scoreField(action.label, terms, exactQuery, 65, 18);
  score += scoreField(action.modelPickerTarget, terms, exactQuery, 58, 18);
  score += scoreField(action.settingsTarget, terms, exactQuery, 58, 18);
  score += scoreField(action.modelPickerFlow, terms, exactQuery, 54, 16);
  score += scoreField(action.localOperation, terms, exactQuery, 50, 16);
  score += scoreField(action.targetCategoryId, terms, exactQuery, 40, 12);
  score += scoreField(action.detail, terms, exactQuery, 24, 6);
  score += scoreField(category.id, terms, exactQuery, 30, 8);
  score += scoreField(category.label, terms, exactQuery, 25, 7);
  score += scoreField(category.summary, terms, exactQuery, 12, 3);
  score += scoreField(category.detail, terms, exactQuery, 8, 2);

  if (category.id === 'setup' && !terms.includes('setup')) score -= 14;
  if (action.id.startsWith('setup-') && !terms.includes('setup')) score -= 18;
  if (action.kind === 'workspace' && !terms.includes('open')) score -= 4;
  return score;
}

export function beginAgentWorkspaceActionSearch(host: AgentWorkspaceSearchHost): void {
  host.actionSearchActive = true;
  host.actionSearchQuery = '';
  host.focusPane = 'actions';
  host.selectedActionIndex = 0;
  host.status = 'Search Agent workspace actions.';
  host.lastActionResult = {
    kind: 'guidance',
    title: 'Action search',
    detail: 'Type to filter every Agent workspace action. Enter opens the selected result; Esc clears search.',
    safety: 'safe',
  };
}

export function appendAgentWorkspaceActionSearchText(host: AgentWorkspaceSearchHost, text: string): void {
  if (!host.actionSearchActive || text.length === 0) return;
  host.actionSearchQuery += text.replace(/[\r\n]+/g, ' ');
  host.selectedActionIndex = 0;
  host.status = actionSearchStatus(host);
  host.clampSelection();
}

export function backspaceAgentWorkspaceActionSearch(host: AgentWorkspaceSearchHost): void {
  if (!host.actionSearchActive || host.actionSearchQuery.length === 0) return;
  const chars = Array.from(host.actionSearchQuery);
  chars.pop();
  host.actionSearchQuery = chars.join('');
  host.selectedActionIndex = 0;
  host.status = host.actionSearchQuery.length === 0 ? 'Search Agent workspace actions.' : actionSearchStatus(host);
  host.clampSelection();
}

export function clearAgentWorkspaceActionSearch(host: AgentWorkspaceSearchHost): void {
  if (!host.actionSearchActive) return;
  host.actionSearchActive = false;
  host.actionSearchQuery = '';
  // selectedActionIndex was an index into the SEARCH RESULTS, which can span
  // every category. Reinterpreting that number as an index into the
  // originating category's own (unrelated) action list silently highlights
  // an arbitrary, wrong action, the highlight desyncs from what the user
  // was just looking at. There is no principled position to preserve across
  // an arbitrary category switch, so return to the top of the list, same as
  // beginning/typing/backspacing a search already does.
  host.selectedActionIndex = 0;
  host.status = 'Action search cleared.';
  host.clampSelection();
}

export function commitAgentWorkspaceActionSearchSelection(
  host: AgentWorkspaceSearchHost,
  result: AgentWorkspaceActionSearchResult | null,
): boolean {
  if (!host.actionSearchActive) return true;
  if (!result) {
    host.status = host.actionSearchQuery.trim().length === 0
      ? 'Type a search query before opening an action.'
      : `No Agent workspace actions match "${host.actionSearchQuery}".`;
    host.lastActionResult = {
      kind: 'guidance',
      title: 'No action selected',
      detail: 'Type a different search query or press Esc to return to normal workspace navigation.',
      safety: 'safe',
    };
    return false;
  }
  host.selectedCategoryIndex = result.categoryIndex;
  host.selectedActionIndex = result.actionIndex;
  host.actionSearchActive = false;
  host.actionSearchQuery = '';
  host.focusActions();
  host.clampSelection();
  return true;
}

function actionSearchStatus(host: AgentWorkspaceSearchHost): string {
  const count = searchAgentWorkspaceActions(host.categories, host.actionSearchQuery).length;
  return count === 0
    ? `No Agent workspace actions match "${host.actionSearchQuery}".`
    : `Found ${count} Agent workspace action(s) for "${host.actionSearchQuery}".`;
}
