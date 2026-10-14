import { expect, test } from 'bun:test';
import { registryCandidateView } from '../sdk/src/platform/tools/batteries/registry-rank.ts';
import { credentialValueState } from '../sdk/src/platform/tools/batteries/credential-value.ts';
import { childFailureView } from '../sdk/src/platform/tools/batteries/child-failure-reason.ts';
import { contentMatchView } from '../sdk/src/platform/tools/batteries/content-rank.ts';
import { execFailureView } from '../sdk/src/platform/tools/batteries/exec-retry.ts';
import { entryPointView } from '../sdk/src/platform/tools/batteries/project-tooling.ts';
import { paragraphCandidate } from '../sdk/src/platform/tools/batteries/page-summary.ts';
import { scanCandidateView } from '../sdk/src/platform/tools/batteries/secret-finding.ts';
import { envTemplateCandidate } from '../sdk/src/platform/tools/batteries/env-template.ts';
import { handlerView, routeLineView } from '../sdk/src/platform/tools/batteries/api-routes.ts';
import { frontendLineView } from '../sdk/src/platform/tools/batteries/frontend-finding.ts';
import { semanticDiffView } from '../sdk/src/platform/tools/batteries/semantic-diff.ts';

const correction = 'The earlier example is obsolete; the actual behavior is the opposite.';
const evidence = `${'Context continues.\n'.repeat(2_000)}${correction}`;
const views = [
  () => registryCandidateView({ type: 'skill', name: 'fixture', description: evidence, preview: evidence }),
  () => credentialValueState('fixture', 'Fixture description', evidence),
  () => childFailureView(evidence),
  () => contentMatchView('fixture.ts', [{ line: 1, text: evidence }]),
  () => execFailureView('fixture', 1, evidence, evidence),
  () => entryPointView('fixture.ts', evidence, {}),
  () => paragraphCandidate('paragraph', evidence),
  () => scanCandidateView('fixture.ts', evidence.split('\n'), 0),
  () => handlerView('fixture.ts', evidence),
  () => routeLineView('fixture', 'fixture.ts', evidence.split('\n'), 0),
  () => frontendLineView('fixture.ts', evidence.split('\n'), 0),
  () => semanticDiffView('before..after', ['fixture.ts'], evidence),
];
test('late corrections survive every tool evidence projection instead of becoming a truncated claim', () => {
  for (const view of views) expect(JSON.stringify(view())).toContain(correction);
});
test('the complete environment declaration catalog participates in template selection', () => {
  const variables = Array.from({ length: 600 }, (_, index) => ({ key: `FIELD_${index}`, blank: index !== 599 }));
  expect(JSON.stringify(envTemplateCandidate('fixture.env', variables))).toContain('FIELD_599=(set)');
});
test('oversized evidence holds instead of silently supplying a prefix', () => {
  expect(() => handlerView('fixture.ts', 'x'.repeat(160_001))).toThrow('input budget');
  expect(() => credentialValueState('fixture', '', 'x'.repeat(160_001))).toThrow('input budget');
});
