import { hashState, type NoulQuestion, type YesNoReading } from '@goodvibes-jev/judgment';

export interface AnswerClaimScope {
  readonly start: number;
  readonly end: number;
  readonly textDigest: string;
}
export interface AnswerClaimReview extends AnswerClaimScope {
  readonly stateHash: string;
  readonly decisionId: string;
  readonly reading: Pick<YesNoReading, 'probability' | 'verdict' | 'outcome'>;
}

/** Bind the exact claim range in the logged question as well as the state. */
export function scopedClaimQuestion(question: NoulQuestion, scope: AnswerClaimScope, outputDigest: string): NoulQuestion {
  return { ...question, instructions: { review: question.instructions ?? null,
    claimScope: { start: scope.start, end: scope.end, textDigest: scope.textDigest, outputDigest } } };
}

/** Contiguous exact text, retaining whitespace and the context around claims. */
export function answerClaimScopes(output: string, start = 0, end = output.length, limit = 4_000): AnswerClaimScope[] {
  const scopes: AnswerClaimScope[] = [];
  let offset = start;
  do {
    let boundary = Math.min(end, offset + limit);
    if (boundary < end) {
      const paragraph = output.lastIndexOf('\n', boundary);
      if (paragraph > offset + limit / 2) boundary = paragraph + 1;
      else {
        const space = output.lastIndexOf(' ', boundary);
        if (space > offset + limit / 2) boundary = space + 1;
      }
    }
    scopes.push({ start: offset, end: boundary, textDigest: hashState(output.slice(offset, boundary)) });
    offset = boundary;
  } while (offset < end);
  return scopes;
}

/** Neither an absent passage nor overlapping checks can qualify an answer. */
export function completeAnswerClaimCoverage(output: string, scopes: readonly AnswerClaimScope[]): boolean {
  let offset = 0;
  if (!scopes.length) return false;
  for (const scope of scopes) {
    if (!scope || !Number.isInteger(scope.start) || !Number.isInteger(scope.end) || scope.start !== offset
      || scope.end < scope.start || scope.end > output.length || scope.end - scope.start > 4_001
      || (scope.end === scope.start && output.length !== 0)
      || scope.textDigest !== hashState(output.slice(scope.start, scope.end))) return false;
    offset = scope.end;
  }
  return offset === output.length && (output.length !== 0 || scopes.length === 1);
}
