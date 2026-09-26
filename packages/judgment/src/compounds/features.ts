import type { ChoiceResponse, EntryType, JudgmentPort, NoulResponse, Question, Questions, ScoreResponse } from '../port/types.ts';
import { recordReadings } from '../batteries/asking.ts';
import { mapLimit } from '../patterns/common.ts';

/** How a Score answer becomes columns: its mean alone, or its mean and spread. */
export type ScoreEncoding = 'mean' | 'mean_spread';

export interface Column {
  readonly name: string;
  readonly values: readonly number[];
}

/** An answer as feature encoding reads it: a yes/no probability or a distribution over options or levels. */
type Answer = NoulResponse | ChoiceResponse | ScoreResponse;

/** The distribution a choice or score answer carries over its options or levels; a yes/no carries none. */
const distributionOf = (answer: Answer): Readonly<Record<string, number>> => (answer.type === 'noul' ? {} : answer.probabilities);
const probabilityOf = (answer: Answer, key: string): number => distributionOf(answer)[key] ?? 0;
const yesOf = (answer: Answer): number => (answer.type === 'noul' ? answer.noul : 0);

function scoreColumns(name: string, probabilities: readonly (readonly number[])[], encoding: ScoreEncoding): Column[] {
  const means = probabilities.map((row) => row.reduce((sum, p, level) => sum + p * level, 0));
  if (encoding === 'mean') return [{ name, values: means }];
  const spreads = probabilities.map((row, i) => Math.sqrt(Math.max(0, row.reduce((sum, p, level) => sum + p * level * level, 0) - means[i]! ** 2)));
  return [
    { name, values: means },
    { name: `${name}_sd`, values: spreads },
  ];
}

/**
 * Turns answers into numeric columns for a classical model (the autoresearch
 * feature discovery cookbook): a yes/no is one column (its probability), a
 * score is its expected level and optionally the spread around it, a choice
 * is one column per option. The model sees numbers only; which questions
 * earn a place is decided by the downstream model's error, not here.
 */
export function encodeColumns(questions: Questions, rows: readonly Readonly<Record<string, Answer>>[], encoding: ScoreEncoding): Column[] {
  return Object.entries(questions).flatMap(([name, question]: [string, Question]) => {
    const answers = rows.map((row) => row[name]!);
    if (question.type === 'noul') return [{ name, values: answers.map(yesOf) }];
    if (question.type === 'score') {
      const levels = Array.from({ length: question.criteria.length }, (_, level) => String(level));
      return scoreColumns(name, answers.map((answer) => levels.map((level) => probabilityOf(answer, level))), encoding);
    }
    return Object.keys(question.criteria).map((option) => ({ name: `${name}=${option}`, values: answers.map((answer) => probabilityOf(answer, option)) }));
  });
}

/** One row of column values, by column name. */
type Row = ReadonlyMap<string, number>;

const rowOf = (columns: readonly Column[]): Row => new Map(columns.map(({ name, values }) => [name, values[0]!]));

/** Stacks one-row encodings into columns, in the first row's column order. */
function stack(rows: readonly Row[]): Column[] {
  const names = [...(rows[0]?.keys() ?? [])];
  return names.map((name) => ({ name, values: rows.map((row) => row.get(name)!) }));
}

/** Asks one question set about many states (one request per state, bounded in flight) and encodes the answers. */
export async function featurize(
  port: JudgmentPort,
  questions: Questions,
  states: readonly EntryType[],
  options: { readonly encoding?: ScoreEncoding; readonly concurrency?: number; readonly label?: string } = {},
): Promise<Column[]> {
  const encoding = options.encoding ?? 'mean_spread';
  const context = { pattern: 'features', ...(options.label === undefined ? {} : { battery: options.label }) };
  const rows = await mapLimit(states, options.concurrency ?? 8, async (state) => {
    const result = await port.ask({ state, questions, context });
    const row = rowOf(encodeColumns(questions, [result.answers as Readonly<Record<string, Answer>>], encoding));
    recordReadings(port, result, { columns: Object.fromEntries(row) });
    return row;
  });
  return stack(rows);
}
