import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Explicit fixture answers, never a production prose classifier. */
export function useBrowserProvisionReadings() {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port } = fakePort((name, question, input) => {
      const state = input as { phase: string; stderr: string; spawnError: string | null; candidate?: string };
      if (name === 'candidate_missing') return noulAnswer(state.candidate === 'libnss3.so' ? 0.99 : 0.01);
      let category = 'other';
      if (state.stderr === 'chrome: error while loading shared libraries: libnss3.so: cannot open shared object file') category = 'missing-library';
      if (state.stderr === 'getaddrinfo ENOTFOUND cdn.playwright.dev') category = 'network-blocked';
      if (state.phase === 'spawn' && state.spawnError?.startsWith('Executable not found in $PATH:')) category = 'program-not-installed';
      return choiceAnswer(question, category, 0.99);
    });
    previous = installJudgmentPort(port);
  });
  afterEach(() => { installJudgmentPort(previous); });
}
