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

import ts from 'typescript';
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

// ── 2. Registered use ────────────────────────────────────────────────────────

const DEFINER = /^define[A-Z]\w*$/;

const propertyNamed = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined =>
  object.properties.find((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === name);

/** A string a name property holds: a literal, or a const in the same file initialised to one. */
function resolveName(property: ts.ObjectLiteralElementLike, file: ts.SourceFile): string | undefined {
  const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
  if (value === undefined) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (!ts.isIdentifier(value)) return undefined;
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === value.text && node.initializer !== undefined) {
      if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) found = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether a node sits inside a function declared as a decision definer (`function defineX(spec)`). */
function insideDefiner(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined && DEFINER.test(current.name.text)) return true;
  }
  return false;
}

/** Registered-use findings for one source file. */
export function sourceFindings(path: string, text: string, registered: ReadonlySet<string>): LintFinding[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: LintFinding[] = [];
  const at = (node: ts.Node): string => `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const callee = node.expression;
      if (ts.isIdentifier(callee) && DEFINER.test(callee.text) && first !== undefined && ts.isObjectLiteralExpression(first)) {
        const name = propertyNamed(first, 'name');
        if (name !== undefined && propertyNamed(first, 'fixtures') !== undefined) {
          const resolved = resolveName(name, file);
          if (resolved === undefined) {
            findings.push({ rule: 'registered-use', where: at(node), message: `${callee.text} defines a decision whose name is not a string this lint can read, so its registration cannot be checked` });
          } else if (!registered.has(resolved)) {
            findings.push({ rule: 'registered-use', where: at(node), message: `${callee.text} defines "${resolved}", which no judgment registry registers` });
          }
        }
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'ask' && first !== undefined && ts.isObjectLiteralExpression(first) && propertyNamed(first, 'questions') !== undefined) {
        findings.push({ rule: 'registered-use', where: at(node), message: 'asks Jev with a request built inline, outside a registered decision' });
      }
      if (ts.isIdentifier(callee) && callee.text === 'askAs' && !insideDefiner(node)) {
        findings.push({ rule: 'registered-use', where: at(node), message: 'calls askAs outside a decision definer (a `function define*`), so the call is attributed to no registered decision' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}
