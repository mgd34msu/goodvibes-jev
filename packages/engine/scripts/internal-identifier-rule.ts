import { captureStaticInputs, staticInputStanding, type StaticSourceReadings } from './static-source-readings.ts';

export interface InternalIdentifierCandidate {
  readonly relPath: string;
  readonly text: string;
}

export const OWNER_DOCTRINE = 'never put wave/work-order/register ids in outward-facing or in-code text; '
  + 'plain language only; provenance via decision-record paths or versions';

export function isInternalIdentifierExempt(relPath: string): boolean {
  return relPath.split('\\').join('/').startsWith('docs/decisions/');
}

/** Offline validation consumes complete current observations. It never guesses from token shapes. */
export function checkNoInternalIdentifiers(
  candidates: readonly InternalIdentifierCandidate[], readings: StaticSourceReadings | null = null,
): string[] {
  const violations: string[] = [];
  for (const { relPath, text } of candidates) {
    if (isInternalIdentifierExempt(relPath)) continue;
    for (const input of captureStaticInputs('internal-identifier', relPath, text)) {
      const standing = staticInputStanding(input, readings);
      if (standing.kind === 'clear') continue;
      if (standing.kind === 'held') {
        violations.push(`${relPath}:${input.firstLine}: internal-identifier evidence held (${standing.reason}); run static-source:read [internal-identifier]`);
      } else {
        violations.push(`${relPath}:${standing.anchor.line}: internal planning identifier; ${OWNER_DOCTRINE} [internal-identifier]`);
      }
    }
  }
  return violations;
}
