import type { EntryType, JsonValue } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

export function processEvidenceRows(state: EntryType, key: string): readonly JsonValue[] {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Expected process evidence');
  const rows = state[key];
  if (!Array.isArray(rows)) throw new Error(`Missing process ${key}`);
  return rows;
}
function field(row: JsonValue | undefined, key: string): JsonValue | undefined {
  return row && typeof row === 'object' && !Array.isArray(row) ? row[key] : undefined;
}
/** Exact authored observations over real public batched requests. */
export function makeProcessOutputReadingFixture(errors: readonly string[], listening: readonly string[]) {
  return fakePort((name, question, state) => {
    if (question.type !== 'noul') throw new Error('Unexpected process output fixture');
    if (name.startsWith('error:')) {
      const line = processEvidenceRows(state, 'lines').find(row => field(row, 'id') === name.slice(6));
      return noulAnswer(errors.includes(String(field(line, 'text'))) ? 0.99 : 0.01);
    }
    const candidate = processEvidenceRows(state, 'candidates').find(row => field(row, 'id') === name.slice(9));
    const line = processEvidenceRows(state, 'lines').find(row => field(row, 'id') === field(candidate, 'lineId'));
    return noulAnswer(listening.includes(String(field(line, 'text'))) ? 0.99 : 0.01);
  });
}
