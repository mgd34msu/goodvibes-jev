import { captureStaticInputs, staticInputStanding, type StaticSourceReadings } from './static-source-readings.ts';

export interface InternalIdentifierCandidate {
  readonly relPath: string;
  readonly text: string;
}

export const OWNER_DOCTRINE = 'never put wave/work-order/register ids in outward-facing or in-code text; '
  + 'plain language only; provenance via decision-record paths or versions';

// The source checker and its fixtures necessarily describe the labels they detect.
const SOURCE_CHECKER_FILES = new Set([
  'scripts/batteries/static-source.ts',
  'scripts/batteries/static-weak-anchor.ts',
  'scripts/check-internal-identifiers.ts',
  'scripts/internal-identifier-rule.ts',
  'scripts/no-todo-marker-rules.ts',
  'scripts/no-todo-markers.ts',
  'scripts/read-static-source.ts',
  'scripts/static-source-anchors.ts',
  'scripts/static-source-readings.ts',
  'scripts/static-source-readings.md',
  'test/_helpers/static-source-evidence.ts',
  'test/internal-identifier-check.test.ts',
  'test/no-todo-markers.test.ts',
  'test/static-source-anchors.test.ts',
  'test/static-source-capture-paths.test.ts',
  'test/static-source-current-projection.test.ts',
  'test/static-source-markdown-context.test.ts',
  'test/static-source-readings.test.ts',
  'test/static-source-structured-context.test.ts',
  'test/static-source-weak-anchor.test.ts',
]);

export function isInternalIdentifierExempt(relPath: string): boolean {
  const path = relPath.split('\\').join('/');
  return path.startsWith('docs/decisions/') || SOURCE_CHECKER_FILES.has(path);
}

/** Offline validation consumes complete current observations. It never guesses from token shapes. */
export function checkNoInternalIdentifiers(
  candidates: readonly InternalIdentifierCandidate[], readings: StaticSourceReadings | null = null,
  onHeld?: (finding: string) => void,
): string[] {
  const violations: string[] = [];
  for (const { relPath, text } of candidates) {
    if (isInternalIdentifierExempt(relPath)) continue;
    for (const input of captureStaticInputs('internal-identifier', relPath, text)) {
      const standing = staticInputStanding(input, readings);
      if (standing.kind === 'clear') continue;
      if (standing.kind === 'held') {
        onHeld?.(`${relPath}:${input.firstLine}: internal-identifier evidence held (${standing.reason}); review source or run static-source:read [internal-identifier]`);
      } else {
        violations.push(`${relPath}:${standing.anchor.line}: internal planning identifier; ${OWNER_DOCTRINE} [internal-identifier]`);
      }
    }
  }
  return violations;
}
