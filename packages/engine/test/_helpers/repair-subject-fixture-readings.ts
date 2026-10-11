import type { RepairSubjectSelectionInput } from '../../sdk/src/platform/knowledge/semantic/repair-subject-selection/types.js';
/** Exact authored synthetic subjects used by the existing consumer fixtures.
 * This supplies mock model answers, never an evaluator or production fallback.
 * Unlisted candidates receive no; callers may override with an exact table.
 */
export const repairSubjectFixtureTitles = [
  'AC-7', 'Model K', 'LG webOS Smart TV', 'Living Room TV', 'Sony BRAVIA TV',
  'Synthetic TV-123', 'Cloudflare', 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
] as const;
export function repairSubjectFixtureReading(state: unknown, fixtures: readonly (readonly [string, number])[] = repairSubjectFixtureTitles.map(title => [title, 0.99] as const)): number {
  const input = state as RepairSubjectSelectionInput;
  const title = input.candidates.find(candidate => candidate.reference === input.candidate)?.title;
  return fixtures.find(([candidate]) => candidate === title)?.[1] ?? 0.01;
}
