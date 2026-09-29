/**
 * A fake judgment port for the config layer's decisions, so tests of
 * credential routing and settings ingestion never call the live Jev API:
 *
 * - `config.credential-key`: keys in `credentials` read as a credential, every
 *   other key as not one;
 * - `config.setting-form`: an unknown name in `forms` reads as a newer form of
 *   the known setting it maps to, any other name as a form of none.
 *
 * Readings are strong (well past the bands), so every one acts.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

export interface ConfigReadingTable {
  /** Keys that read as holding a credential. */
  readonly credentials?: readonly string[];
  /** Unknown setting name to the known setting name it is a newer form of. */
  readonly forms?: Readonly<Record<string, string>>;
}

type SelectionState = { readonly context: { readonly name: string }; readonly candidates: readonly { readonly id: string }[] };

function isSelection(state: EntryType): state is EntryType & SelectionState {
  return typeof state === 'object' && state !== null && 'candidates' in state && 'context' in state;
}

/** A port answering the config decisions from `table`, recording every request. */
export function configReadingsPort(table: ConfigReadingTable) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (isSelection(state)) {
      const form = table.forms?.[state.context.name];
      if (name === 'pick') return choiceAnswer(question, form ?? 'none', 0.95);
      const index = Number(name.slice('fits_'.length));
      return noulAnswer(state.candidates[index]?.id === form ? 0.97 : 0.03);
    }
    const key = (state as { readonly key?: string }).key ?? '';
    return noulAnswer(table.credentials?.includes(key) ? 0.97 : 0.03);
  });
}

/** Installs a {@link configReadingsPort} around every test in the calling file or block; returns its request log. */
export function useConfigReadings(table: ConfigReadingTable): { readonly requests: ReadonlyArray<{ readonly state: unknown }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port, requests } = configReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return log;
}
