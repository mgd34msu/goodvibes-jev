/**
 * model-picker-family.test.ts
 *
 * The model picker files each model under a family read by
 * `engine.runtime.model-family`, once per exact evidence and installed port.
 * A model has no family
 * until its reading lands; a reading that does not settle leaves it without
 * one and is not asked again; a read that throws leaves the model unread so a
 * later read asks again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ModelFamilyReadings } from '../sdk/src/platform/runtime/ui/model-picker/model-family-readings.ts';

type ModelState = { readonly id: string };

const model = (id: string) => ({ registryKey: `test:${id}`, id, displayName: id, provider: 'test' });

/** A port reading each model's family from `answers` (family, confidence), recording the ids asked. */
function familyPort(answers: Record<string, [string, number]>, asked: string[]) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name !== 'family') throw new Error(`model family port: unexpected question ${name}`);
    const id = (state as unknown as ModelState).id;
    asked.push(id);
    const [family, confidence] = answers[id] ?? ['Other', 0.95];
    return choiceAnswer(question, family, confidence);
  }).port;
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('ModelFamilyReadings', () => {
  test('a settled reading files the model; each model is asked once', async () => {
    const asked: string[] = [];
    installJudgmentPort(familyPort({ 'claude-sonnet-4-5': ['Claude', 0.95], 'command-r-plus': ['Command', 0.95] }, asked));
    const readings = new ModelFamilyReadings();
    expect(readings.known(model('claude-sonnet-4-5'))).toBeUndefined();
    expect(await readings.read([model('claude-sonnet-4-5'), model('command-r-plus')])).toBe(true);
    expect(readings.known(model('claude-sonnet-4-5'))).toBe('Claude');
    expect(readings.known(model('command-r-plus'))).toBe('Command');
    expect(await readings.read([model('claude-sonnet-4-5')])).toBe(false);
    expect(asked).toEqual(['claude-sonnet-4-5', 'command-r-plus']);
  });

  test('a reading that does not settle leaves no family and is not asked again', async () => {
    const asked: string[] = [];
    installJudgmentPort(familyPort({ 'mystery-7b': ['Llama', 0.3] }, asked));
    const readings = new ModelFamilyReadings();
    expect(await readings.read([model('mystery-7b')])).toBe(false);
    expect(readings.known(model('mystery-7b'))).toBeUndefined();
    await readings.read([model('mystery-7b')]);
    expect(asked).toEqual(['mystery-7b']);
  });

  test('a read with no port throws and leaves the model unread', async () => {
    const readings = new ModelFamilyReadings();
    await expect(readings.read([model('gpt-5')])).rejects.toBeInstanceOf(JudgmentPortMissingError);
    const asked: string[] = [];
    installJudgmentPort(familyPort({ 'gpt-5': ['GPT', 0.95] }, asked));
    expect(await readings.read([model('gpt-5')])).toBe(true);
    expect(readings.known(model('gpt-5'))).toBe('GPT');
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('shared family evidence ownership', () => {
  test('concurrent callers join the same judgment and repeated calls reuse it', async () => {
    const gate = deferred();
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) { await gate.promise; return fixture.port.ask(request); } });
    const readings = new ModelFamilyReadings();
    const evidence = model('opaque');
    const first = readings.read([evidence]);
    const second = readings.read([evidence]);
    gate.resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(await readings.read([evidence])).toBe(false);
  });

  test('replacement metadata under a registry key cannot inherit or be overwritten by an old judgment', async () => {
    const gate = deferred();
    const fixture = fakePort((_name, question, state) => choiceAnswer(question,
      (state as unknown as { displayName: string }).displayName === 'Old' ? 'GPT' : 'Llama', 0.99));
    installJudgmentPort({ ...fixture.port, async ask(request) {
      if ((request.state as unknown as { displayName: string }).displayName === 'Old') await gate.promise;
      return fixture.port.ask(request);
    } });
    const readings = new ModelFamilyReadings();
    const old = { ...model('alias'), displayName: 'Old' };
    const replacement = { ...old, displayName: 'New' };
    const pending = readings.read([old]);
    expect(readings.known(replacement)).toBeUndefined();
    await readings.read([replacement]);
    expect(readings.known(replacement)).toBe('Llama');
    gate.resolve();
    await pending;
    expect(readings.known(replacement)).toBe('Llama');
    expect(readings.known(old)).toBe('GPT');
    expect(fixture.requests).toHaveLength(2);
  });

  test('installed-port replacement isolates cached and in-flight judgments', async () => {
    const readings = new ModelFamilyReadings();
    const evidence = model('authority');
    const gate = deferred();
    const oldPort = fakePort((_name, question) => choiceAnswer(question, 'GPT', 0.99)).port;
    installJudgmentPort({ ...oldPort, async ask(request) { await gate.promise; return oldPort.ask(request); } });
    const oldRead = readings.read([evidence]).then(() => null, error => error);
    installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'Claude', 0.99)).port);
    expect(readings.known(evidence)).toBeUndefined();
    await readings.read([evidence]);
    gate.resolve();
    expect(await oldRead).toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
    expect(readings.known(evidence)).toBe('Claude');
    installJudgmentPort(undefined);
    expect(readings.known(evidence)).toBeUndefined();
  });

  test('a failed judgment retries without creating an Other verdict', async () => {
    let fails = true;
    const fixture = fakePort((_name, question) => {
      if (fails) throw new Error('offline');
      return choiceAnswer(question, 'Other', 0.99);
    });
    installJudgmentPort(fixture.port);
    const readings = new ModelFamilyReadings();
    const evidence = model('commandline-helper');
    await expect(readings.read([evidence])).rejects.toThrow('offline');
    expect(readings.known(evidence)).toBeUndefined();
    fails = false;
    await readings.read([evidence]);
    expect(readings.known(evidence)).toBe('Other');
    expect(fixture.requests).toHaveLength(2);
  });
});
