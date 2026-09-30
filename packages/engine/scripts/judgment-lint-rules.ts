// judgment-lint-rules.ts
//
// The semantic CI lints over the engine's Jev use, kept apart from the CLI
// (judgment-lint.ts) so tests can run them on in-memory decisions and source.
//
//   1. Fixture coverage: every answer a registered decision's question can
//      conclude (yes and no, each option, each rubric level, each route) has
//      at least one labelled fixture expecting it. A decision nobody has
//      shown an example of an answer for cannot be calibrated on it.
//   2. Registered use: a site asks Jev only through a registered decision.
//      A decision defined in source (a `define*` call with a name and
//      fixtures) must be in a registry; a request built inline and sent to a
//      port's `ask`, or an `askAs` outside a decision definer, bypasses
//      batteries altogether.

import type { FixtureCheck, JudgmentPort, NamedDecision, Question } from '@goodvibes-jev/judgment';

export interface LintFinding {
  readonly rule: 'fixture-coverage' | 'registered-use';
  /** The decision name or the source location. */
  readonly where: string;
  readonly message: string;
}

// ── 1. Fixture coverage ──────────────────────────────────────────────────────

/**
 * A port that answers every question confidently with its first option (yes,
 * the first choice, level 0). What a check expects comes from its fixture,
 * not from the answer, so any fixed answer lists every expectation; nothing
 * leaves the process.
 */
export const enumeratingPort: JudgmentPort = {
  model: 'lint',
  async ask(request) {
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, firstAnswer(question)]));
    return { answers: answers as never, requestedModel: 'lint', model: 'lint', usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, requestId: undefined };
  },
};

function firstAnswer(question: Question): unknown {
  if (question.type === 'noul') return { type: 'noul', noul: 0.9 };
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    return { type: 'choice', choice: options[0], confidence: 0.9, probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.9 : 0.1 / Math.max(1, options.length - 1)])) };
  }
  const levels = question.criteria.map((_, level) => String(level));
  return { type: 'score', score: 0, confidence: 0.9, legend: {}, probabilities: Object.fromEntries(levels.map((level) => [level, level === '0' ? 1 : 0])) };
}

/** What one question of one decision covers. */
export interface QuestionCoverage {
  readonly question: string;
  /** Every answer the question can conclude; undefined when the answers depend on each fixture's data. */
  readonly answers: readonly string[] | undefined;
  readonly expected: readonly string[];
  readonly missing: readonly string[];
}

/**
 * Coverage per question, from a decision's fixture checks. Checks name their
 * question (or their aspect is the question) and carry the closed answer set
 * when there is one; a question whose answer set differs between fixtures
 * (options drawn from each fixture's own candidates) has no fixed set to cover.
 */
export function questionCoverage(checks: readonly FixtureCheck[]): QuestionCoverage[] {
  const byQuestion = new Map<string, FixtureCheck[]>();
  for (const check of checks) {
    const question = check.question ?? check.aspect;
    const list = byQuestion.get(question) ?? [];
    list.push(check);
    byQuestion.set(question, list);
  }
  return [...byQuestion]
    .map(([question, list]) => {
      const sets = new Set(list.map((check) => (check.answers === undefined ? '' : JSON.stringify(check.answers))));
      const closed = sets.size === 1 && !sets.has('');
      const answers = closed ? list[0]!.answers! : undefined;
      const expected = [...new Set(list.map((check) => check.expected))].sort();
      return { question, answers, expected, missing: answers === undefined ? [] : answers.filter((answer) => !expected.includes(answer)) };
    })
    .sort((a, b) => a.question.localeCompare(b.question));
}

/** Coverage findings for every decision: an uncovered answer, or fixtures that cannot be listed at all. */
export async function coverageFindings(decisions: readonly NamedDecision[]): Promise<{ findings: LintFinding[]; open: string[] }> {
  const findings: LintFinding[] = [];
  const open: string[] = [];
  for (const decision of decisions) {
    let checks: readonly FixtureCheck[];
    try {
      checks = await decision.checkFixtures(enumeratingPort);
    } catch (error) {
      findings.push({ rule: 'fixture-coverage', where: decision.name, message: `its fixtures could not be listed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    for (const coverage of questionCoverage(checks)) {
      if (coverage.answers === undefined) {
        open.push(`${decision.name} ${coverage.question}`);
        continue;
      }
      if (coverage.missing.length > 0) {
        findings.push({
          rule: 'fixture-coverage',
          where: decision.name,
          message: `question "${coverage.question}" has no fixture expecting ${coverage.missing.map((answer) => `"${answer}"`).join(', ')} (answers ${coverage.answers.join(', ')})`,
        });
      }
    }
  }
  return { findings, open };
}

// Source registration checks share the same finding type.
export { sourceFindings } from './judgment-lint-source.ts';
