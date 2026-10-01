/** Authored plumbing outcomes, not a keyword-based semantic evaluator. */
export interface AnswerObjectFixtureReadings {
  readonly query: string;
  readonly integrationIntent?: number;
  readonly objects: readonly { readonly title: string; readonly concreteObject: number; readonly integrationObject: number; readonly aligned: number }[];
}
export function answerObjectFixtureReading(name: string, state: unknown, fixtures: readonly AnswerObjectFixtureReadings[] = []): number | undefined {
  if (!['integrationIntent', 'concreteObject', 'integrationObject', 'aligned'].includes(name)) return undefined;
  const input = state as { readonly query?: string; readonly candidate?: { readonly title?: string } };
  const fixture = fixtures.find((entry) => entry.query === input.query);
  if (name === 'integrationIntent') return fixture?.integrationIntent ?? 0.01;
  const object = fixture?.objects.find((entry) => entry.title === input.candidate?.title);
  // An unlisted fixture object receives a settled rejection, never implicit yes.
  return object?.[name as 'concreteObject' | 'integrationObject' | 'aligned'] ?? 0.01;
}
