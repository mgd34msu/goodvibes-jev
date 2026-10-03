import { expect, test } from 'bun:test';
import { failureReading, failureState, forgetFailureReadings, judgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { classifyConnectedHostScheduleError } from '../../agent/routine-schedule-promotion.ts';

test('Agent bootstrap installs the logged engine port consumed by schedule failure classification', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'offline-schedule-bootstrap-fixture';
  const observed: unknown[] = [];
  const questions = Object.fromEntries(Object.entries(failureReading.items).map(([name, item]) => [name, item.question]));
  const message = 'Schedule bootstrap fixture lost its upstream socket';
  const expectedState = failureState({ message, errorName: 'Error' });
  globalThis.fetch = mockFetch(async (input, init) => {
    const url = String(input);
    if (url !== 'http://127.0.0.1:39991/v1/systemone') throw new Error(`Unexpected fixture URL: ${url}`);
    const body = JSON.parse(String(init?.body)) as { state: unknown; questions: unknown; model: string };
    observed.push(body);
    expect(body.state).toBe(expectedState);
    expect(body.questions).toEqual(questions);
    const answers = Object.fromEntries(Object.entries(questions).map(([name, question]) => [name,
      name === 'category' ? choiceAnswer(question, 'network', 0.99)
        : name === 'connection_failure' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01),
    ]));
    return Response.json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    const services = getTestRuntimeServices();
    services.configManager.set('judgment.endpoint', 'http://127.0.0.1:39991');
    services.configManager.set('judgment.keySource', 'env');
    expect(judgmentPort('bootstrap-fixture')).toBe(services.judgment.port);
    forgetFailureReadings();
    const result = await classifyConnectedHostScheduleError(new Error(message), {
      baseUrl: 'http://127.0.0.1:3421', token: 'fixture', tokenPath: '/fixture/token',
    }, { route: '/api/automation/schedules', incompatibleMessage: 'Unavailable schedule method' });
    expect(result).toMatchObject({ kind: 'connected_host_unavailable', error: message });
    expect(observed).toHaveLength(1);
  } finally {
    resetTestRuntimeServices();
    forgetFailureReadings();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  }
});
