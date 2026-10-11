/** Product-owned synthetic transport answers. No private source setter, cache reset or admission shortcut. */
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
export interface SyntheticGateReading {
  readonly family?: string;
  readonly kind?: string;
  readonly capability?: string;
  readonly hazard?: string;
  readonly mutates?: boolean;
  readonly outward?: boolean;
  readonly names_path?: boolean;
  readonly names_host?: boolean;
}
export function gateReadingsPort(table: ReadonlyArray<readonly [string, SyntheticGateReading]> = []) {
  return fakePort((name, question, state) => {
    const reading = { mutates: true, ...(table.find(([match]) => JSON.stringify(state).includes(match))?.[1] ?? {}) };
    if (name === 'family') return choiceAnswer(question, reading.family ?? 'generic', 0.95);
    if (name === 'kind') return choiceAnswer(question, reading.kind ?? 'other', 0.95);
    if (name === 'capability') return choiceAnswer(question, reading.capability ?? 'generic', 0.95);
    if (name === 'hazard') return choiceAnswer(question, reading.hazard ?? 'none', 0.95);
    if (question.type === 'noul') return noulAnswer(reading[name as keyof typeof reading] === true ? 0.97 : 0.03);
    throw new Error(`Unspecified synthetic gate question: ${name}`);
  });
}
