import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type EntryType, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** One per-field check, framed so that yes means something is wrong. */
export interface FieldMetric {
  readonly question: string;
  readonly wrong: string;
  readonly right: string;
}

/** The per-field checks for a field that holds a value. */
export type ValueMetric = 'hallucinated' | 'off_target' | 'name_mismatch' | 'format_violation';
/** The one check for an empty field. */
export type AbsenceMetric = 'absence_wrong';
export type Metric = ValueMetric | AbsenceMetric;

/** The SDE cascade's per-field metrics for a field that holds a value. */
export const FIELD_METRICS: Readonly<Record<ValueMetric, FieldMetric>> = {
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

/** One per-field check's result: the probability that the field is wrong in the way the metric asks. */
export interface FieldCheck {
  readonly field: string;
  readonly metric: Metric;
  readonly p: number;
}

export interface Verified {
  readonly escalate: boolean;
  /** Checks at or above the firing line, strongest first. */
  readonly fired: readonly FieldCheck[];
  readonly checks: readonly FieldCheck[];
}

export interface ExtractionVerifier extends NamedDecision {
  verify(port: JudgmentPort, input: ExtractionInput, options?: CallOptions): Promise<Verified>;
}

const isBlank = (value: JsonValue | undefined): boolean => value === undefined || value === null;
const hasNoLength = (value: JsonValue | undefined): boolean => (typeof value === 'string' || Array.isArray(value)) && value.length === 0;
const isEmpty = (value: JsonValue | undefined): boolean => isBlank(value) || hasNoLength(value);

const SEPARATOR = '::';
const checkKey = (field: string, metric: Metric): string => `${field}${SEPARATOR}${metric}`;
const toFieldCheck = ([key, p]: [string, number]): FieldCheck => {
  const [field, metric] = key.split(SEPARATOR) as [string, Metric];
  return { field, metric, p };
};

function fieldQuestions(name: string, spec: FieldSpec, value: JsonValue | undefined): [string, NoulQuestion][] {
  const fieldSpec = { path: name, type: spec.type ?? 'unknown', description: spec.description ?? '', required: spec.required ?? false };
  const ask = (metric: FieldMetric): NoulQuestion =>
    noul({ field_spec: fieldSpec, extracted_field: value ?? null, main_question: metric.question } as EntryType, {
      true: metric.wrong,
      false: metric.right,
    });
  if (isEmpty(value)) return [[checkKey(name, 'absence_wrong'), ask(ABSENCE_METRIC)]];
  return (Object.entries(FIELD_METRICS) as [ValueMetric, FieldMetric][]).map(([metric, spec_]) => [checkKey(name, metric), ask(spec_)]);
}

export function defineExtractionVerifier(spec: ExtractionVerifierSpec): ExtractionVerifier {
  const header = decisionHeader(spec);
  if (!(spec.fireAt > 0 && spec.fireAt <= 1)) throw new RangeError(`extraction verifier ${spec.name}: fireAt must be in (0, 1]`);

  const verifier: ExtractionVerifier = {
    ...header,
    async verify(port, input, options = {}) {
      const questions = Object.fromEntries(
        Object.entries(input.fields).flatMap(([name, field]) => fieldQuestions(name, field, input.record[name])),
      );
      const state = { instruction: input.instruction, source_text: input.source, extraction: input.record } as EntryType;
      const result = await askAs(port, spec, 'extraction', state, questions, options);
      const checks = Object.entries(result.answers).map(([key, answer]) => toFieldCheck([key, (answer as { noul: number }).noul]));
      const fired = checks.filter(({ p }) => p >= spec.fireAt).sort((a, b) => b.p - a.p);
      const verified = { escalate: fired.length > 0, fired, checks };
      recordReadings(port, result, verified);
      return verified;
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await verifier.verify(port, fixture, run);
        const strongest = Math.max(...got.checks.map(({ p }) => p));
        const signal = got.escalate ? strongest : 1 - strongest;
        return fixtureCheck(fixture.name, 'escalate', String(fixture.expect.escalate), String(got.escalate), signal, 'act', { answers: ['true', 'false'] });
      }),
  };
  return verifier;
}
