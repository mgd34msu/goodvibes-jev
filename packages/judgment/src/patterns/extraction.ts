import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type EntryType, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

/** One per-field check, framed so that yes means something is wrong. */
export interface FieldMetric {
  readonly question: string;
  readonly wrong: string;
  readonly right: string;
}

/** The SDE cascade's per-field metrics for a field that holds a value. */
export const FIELD_METRICS: Readonly<Record<string, FieldMetric>> = {
  hallucinated: {
    question: 'Is the `extracted_field` unsupported by, or absent from, the source text?',
    wrong: 'The value is not supported by, or is absent from, the source text.',
    right: 'The value is supported by the source text.',
  },
  off_target: {
    question: 'Does the source text fail to genuinely report the thing the `field_spec` describes, so the value was pulled from incidental text?',
    wrong: 'The source does not genuinely provide this field; the value was pulled from incidental text.',
    right: 'The source genuinely reports this field.',
  },
  name_mismatch: {
    question: 'Does the `extracted_field` fail to match the field at `path` or its `description` in the `field_spec`?',
    wrong: 'The value does not match the field name or its description.',
    right: 'The value matches the field name and description.',
  },
  format_violation: {
    question: 'Does the `extracted_field` violate the format or constraints implied by the `description` and `type` (date format, units, allowed values)?',
    wrong: 'The value violates the implied format or constraints.',
    right: 'The value satisfies the format and constraints.',
  },
};

/** The one check for an empty field: did the source hold a value after all? */
export const ABSENCE_METRIC: FieldMetric = {
  question: 'The `extracted_field` is empty. Does the source text contain the information the `field_spec` describes, making the empty result wrong?',
  wrong: 'A value was wrongly omitted.',
  right: 'Returning nothing is correct.',
};

export interface FieldSpec {
  readonly description?: string;
  readonly type?: string;
  readonly required?: boolean;
}

export interface ExtractionInput {
  readonly instruction: string;
  readonly source: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly record: Readonly<Record<string, JsonValue>>;
}

/**
 * Per-field extraction verification (the SDE cascade's verifier): every
 * field of an extracted record gets the metric battery (a filled field) or
 * the absence check (an empty one), all in one request, each framed so yes
 * means wrong. Aggregation is max-style: any check at or above `fireAt`
 * fires and the record is escalated, so one confident red flag is never
 * averaged away. The fired list names the field and the metric.
 */
export interface ExtractionVerifierSpec extends PatternHeader {
  readonly fireAt: number;
  readonly fixtures: readonly (ExtractionInput & {
    readonly name: string;
    readonly expect: { readonly escalate: boolean };
  })[];
}

export interface Verified {
  readonly escalate: boolean;
  /** `field::metric` checks at or above the firing line, strongest first. */
  readonly fired: readonly { readonly check: string; readonly p: number }[];
  readonly checks: Readonly<Record<string, number>>;
}

export interface ExtractionVerifier extends NamedDecision {
  verify(port: JudgmentPort, input: ExtractionInput, options?: CallOptions): Promise<Verified>;
}

const isEmpty = (value: JsonValue | undefined): boolean =>
  value === undefined || value === null || ((typeof value === 'string' || Array.isArray(value)) && value.length === 0);

function fieldQuestions(name: string, spec: FieldSpec, value: JsonValue | undefined): [string, NoulQuestion][] {
  const fieldSpec = { path: name, type: spec.type ?? 'unknown', description: spec.description ?? '', required: spec.required ?? false };
  const ask = (metric: FieldMetric): NoulQuestion =>
    noul({ field_spec: fieldSpec, extracted_field: value ?? null, main_question: metric.question } as EntryType, {
      true: metric.wrong,
      false: metric.right,
    });
  if (isEmpty(value)) return [[`${name}::absence_wrong`, ask(ABSENCE_METRIC)]];
  return Object.entries(FIELD_METRICS).map(([metric, spec_]) => [`${name}::${metric}`, ask(spec_)]);
}

export function defineExtractionVerifier(spec: ExtractionVerifierSpec): ExtractionVerifier {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  if (!(spec.fireAt > 0 && spec.fireAt <= 1)) throw new RangeError(`extraction verifier ${spec.name}: fireAt must be in (0, 1]`);

  const verifier: ExtractionVerifier = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async verify(port, input, options = {}) {
      const questions = Object.fromEntries(
        Object.entries(input.fields).flatMap(([name, field]) => fieldQuestions(name, field, input.record[name])),
      );
      const state = { instruction: input.instruction, source_text: input.source, extraction: input.record } as EntryType;
      const result = await askAs(port, spec, 'extraction', state, questions, options);
      const checks = Object.fromEntries(Object.entries(result.answers).map(([name, answer]) => [name, (answer as { noul: number }).noul]));
      const fired = Object.entries(checks)
        .filter(([, p]) => p >= spec.fireAt)
        .sort((a, b) => b[1] - a[1])
        .map(([check, p]) => ({ check, p }));
      const verified = { escalate: fired.length > 0, fired, checks };
      recordReadings(port, result, verified);
      return verified;
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await verifier.verify(port, fixture, { site: 'calibration', ...options });
        const strongest = Math.max(...Object.values(got.checks));
        checks.push({
          fixture: fixture.name,
          aspect: 'escalate',
          expected: String(fixture.expect.escalate),
          got: String(got.escalate),
          correct: got.escalate === fixture.expect.escalate,
          signal: got.escalate ? strongest : 1 - strongest,
          outcome: 'act',
        });
      }
      return checks;
    },
  };
  return verifier;
}
