import {
  actionOf,
  concludedAnswer,
  readingSignal,
  readingsOf,
  type AnyReading,
  type DecisionEntry,
  type JsonValue,
  type Outcome,
} from '@goodvibes-jev/judgment';

/**
 * One reading a decision took, flattened out of its decision log entry: where
 * it was taken, which question it answered, how strong it was and what band
 * outcome it reached.
 */
export interface LoggedReading {
  readonly decisionId: string;
  readonly at: string;
  /** The named decision the call was made for; undefined when the call named none. */
  readonly battery: string | undefined;
  readonly batteryVersion: number | undefined;
  readonly site: string | undefined;
  readonly pattern: string | undefined;
  /** The versioned model that answered. */
  readonly model: string;
  /**
   * The question the reading answers, as its path in the entry's readings
   * note. Per-item positions (`#3`, `criteria.2`) are folded to `[n]` so one
   * question asked about many items groups as one.
   */
  readonly question: string;
  readonly kind: AnyReading['kind'];
  /** The winning probability of a yes/no, the confidence of a choice or score. */
  readonly signal: number;
  readonly outcome: Outcome;
  /** What the reading settled on: yes or no, the option, the level. */
  readonly answer: string;
  /** What code did with the decision, when it recorded that. */
  readonly action: string | undefined;
}

const READING_KINDS: ReadonlySet<string> = new Set(['yes-no', 'choice', 'score']);
const OUTCOMES: ReadonlySet<string> = new Set(['act', 'confirm', 'escalate']);

type JsonObject = { readonly [key: string]: JsonValue };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a stored value has the shape of a yes/no, choice or score reading. */
function asReading(value: JsonObject): AnyReading | undefined {
  if (!READING_KINDS.has(String(value['kind'])) || !OUTCOMES.has(String(value['outcome']))) return undefined;
  if (value['kind'] === 'yes-no') return typeof value['probability'] === 'number' ? (value as unknown as AnyReading) : undefined;
  if (typeof value['confidence'] !== 'number') return undefined;
  if (value['kind'] === 'choice') return typeof value['choice'] === 'string' ? (value as unknown as AnyReading) : undefined;
  return typeof value['level'] === 'number' && Array.isArray(value['probabilities']) ? (value as unknown as AnyReading) : undefined;
}

/** A per-item position in a readings path: an array index or a `#n` message number. */
const ITEM_POSITION = /^#?\d+$/;
const segmentLabel = (segment: string): string => (ITEM_POSITION.test(segment) ? '[n]' : segment);

/** Every reading in a readings note, with its path. A reading is a leaf: nothing inside it is searched. */
function findReadings(value: JsonValue | undefined, path: readonly string[]): Array<{ readonly path: readonly string[]; readonly reading: AnyReading }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => findReadings(item, [...path, String(index)]));
  if (!isObject(value)) return [];
  const reading = asReading(value);
  if (reading !== undefined) return [{ path, reading }];
  return Object.entries(value).flatMap(([key, inner]) => findReadings(inner, [...path, key]));
}

/** The readings of one answered entry; a failed entry or one with no readings note has none. */
export function readingsOfEntry(entry: DecisionEntry): LoggedReading[] {
  if (entry.status !== 'answered') return [];
  const action = actionOf(entry);
  return findReadings(readingsOf(entry), []).map(({ path, reading }) => ({
    decisionId: entry.id,
    at: entry.at,
    battery: entry.context.battery,
    batteryVersion: entry.context.batteryVersion,
    site: entry.context.site,
    pattern: entry.context.pattern,
    model: entry.model,
    question: path.length === 0 ? '(reading)' : path.map(segmentLabel).join('.'),
    kind: reading.kind,
    signal: readingSignal(reading),
    outcome: reading.outcome,
    answer: concludedAnswer(reading),
    action,
  }));
}

/** Every reading the entries hold, in entry order. */
export function loggedReadings(entries: readonly DecisionEntry[]): LoggedReading[] {
  return entries.flatMap(readingsOfEntry);
}

/** A group key's label for a value the call did not name. */
export const UNNAMED = '(none)';
