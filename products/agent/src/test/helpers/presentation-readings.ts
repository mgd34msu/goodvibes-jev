import { beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareSystemMessagePresentation } from '@goodvibes-jev/engine/sdk/platform/runtime';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';

/** Authored presentation fixtures, prepared before synchronous rendering. */
export function usePresentationReadings(entries: readonly (readonly [string, 'error' | 'warning' | 'info', ('remote_status' | 'system_notice')?])[]) {
  let previous: JudgmentPort | undefined;
  beforeEach(async () => {
    previous = installJudgmentPort(fakePort((name, question, state) => {
      const content = (state as { content: string }).content;
      const entry = entries.find(([text]) => text === content);
      if (!entry) throw new Error('Unscripted presentation fixture');
      return choiceAnswer(question, name === 'severity' ? entry[1] : name === 'event' ? entry[2] ?? 'system_notice' : 'system', 1);
    }).port);
    for (const [content] of entries) await prepareSystemMessagePresentation(content);
  });
  afterEach(() => { installJudgmentPort(previous); });
}
