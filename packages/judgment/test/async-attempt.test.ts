import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { APIError } from '@typesafe-ai/sdk';
import { createSystemOnePort, defineBattery, fanOut, JudgmentError, noul, PINNED_MODEL, STAKES_BANDS, yesNo, type JudgmentConfig } from '../src/index.ts';
import { askAs } from '../src/batteries/asking.ts';

const request = { state: 'synthetic', questions: { yes: noul('Synthetic question') } };
const good = () => Response.json({ model: PINNED_MODEL, answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } });
const unavailable = () => Response.json({}, { status: 503 });
const config = (fetch: NonNullable<JudgmentConfig['fetch']>): JudgmentConfig => ({
  endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' },
  model: PINNED_MODEL, timeoutMs: 50, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch,
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe('asynchronous judgment attempt admission', () => {
  test('CallOptions forwards asynchronous admission and preserves the final synchronous guard', async () => {
    const steps: string[] = [];
    const port = createSystemOnePort(config(async (_url, init) => {
      steps.push('fetch');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ state: request.state, questions: request.questions, model: PINNED_MODEL });
      return good();
    }));
    const result = await askAs(port, { name: 'synthetic-battery', version: 1, description: 'Synthetic async admission', accuracyFloor: 0.9 }, 'battery', request.state, request.questions, {
      beforeAsyncAttempt: async () => { steps.push('async start'); await Promise.resolve(); steps.push('async end'); },
      beforeAttempt: () => { steps.push('sync'); },
    });
    expect(result.answers.yes.noul).toBe(0.9);
    expect(steps).toEqual(['async start', 'async end', 'sync', 'fetch']);
    expect(result.lineage?.attempts).toHaveLength(1);
  });

  test('fan-out asynchronous admission can deny before any SDK transmission', async () => {
    let calls = 0; let checks = 0;
    const battery = defineBattery({ name: 'test.async-fan-out', version: 1, description: 'Synthetic async admission', accuracyFloor: 0.9,
      items: { yes: yesNo('Synthetic question', STAKES_BANDS.low.yesNo) },
      fixtures: [{ name: 'synthetic', state: 'synthetic', expect: { yes: 'yes' } }],
    });
    const port = createSystemOnePort(config(async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      return Response.json({ model: PINNED_MODEL,
        answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: 'noul', noul: 0.9 }])),
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }));
    await expect(fanOut(port, 'synthetic', { battery }, {
      beforeAsyncAttempt: async () => { checks++; await Promise.resolve(); throw new Error('access restricted'); },
    })).rejects.toMatchObject({ kind: 'rejected' });
    expect(checks).toBe(1); expect(calls).toBe(0);
  });

  test('permission revoked while asynchronous admission is pending prevents transmission', async () => {
    let calls = 0; let allowed = true; let syncChecks = 0;
    const entered = deferred<void>(); const release = deferred<void>();
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    const pending = port.ask({ ...request,
      beforeAsyncAttempt: async () => { entered.resolve(); await release.promise; if (!allowed) throw new Error('synthetic private denial detail'); },
      beforeAttempt: () => { syncChecks++; },
    });
    await entered.promise;
    expect(calls).toBe(0); allowed = false; release.resolve();
    await expect(pending).rejects.toMatchObject({ kind: 'rejected', message: 'the judgment attempt is no longer authorized', lineage: { attempts: [] } });
    expect(calls).toBe(0); expect(syncChecks).toBe(0);
    expect(port.health?.()[0]?.attempts).toBe(0);
  });

  test.each(['ordinary', 'unavailable judgment', 'upstream HTTP'] as const)('a rejected %s admission never retries or reaches a fallback', async (kind) => {
    let calls = 0; let gates = 0; let retries = 0;
    const port = createSystemOnePort({ ...config(async () => { calls++; return good(); }),
      fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'fallback-key' }, model: PINNED_MODEL }],
    });
    const error = kind === 'ordinary' ? new Error('synthetic private detail')
      : kind === 'unavailable judgment' ? new JudgmentError('unavailable', 'synthetic private detail')
      : APIError.fromResponse(503, {}, new Headers());
    await expect(port.ask({ ...request, beforeAsyncAttempt: async () => { gates++; await Promise.resolve(); throw error; },
      onRetry: () => { retries++; },
    })).rejects.toMatchObject({ kind: 'rejected', message: 'the judgment attempt is no longer authorized', lineage: { attempts: [] } });
    expect(gates).toBe(1); expect(calls).toBe(0); expect(retries).toBe(0);
    expect(port.health?.().map((endpoint) => endpoint.attempts)).toEqual([0, 0]);
  });

  test.each(['resolve', 'reject'] as const)('cancellation interrupts an uncooperative gate and ignores its late %s', async (outcome) => {
    let calls = 0; let syncChecks = 0;
    const controller = new AbortController(); const entered = deferred<void>(); const release = deferred<void>();
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    const pending = port.ask({ ...request, signal: controller.signal,
      beforeAsyncAttempt: async () => { entered.resolve(); await release.promise; },
      beforeAttempt: () => { syncChecks++; },
    });
    await entered.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', lineage: { attempts: [] } });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    if (outcome === 'resolve') release.resolve(); else release.reject(new Error('late private gate error'));
    await tick();
    expect(calls).toBe(0); expect(syncChecks).toBe(0);
  });

  test('an already-aborted call invokes neither asynchronous admission nor the SDK', async () => {
    let calls = 0; let gates = 0;
    const controller = new AbortController(); controller.abort();
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request, signal: controller.signal,
      beforeAsyncAttempt: async () => { gates++; },
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(gates).toBe(0); expect(calls).toBe(0);
  });

  test('cancellation inside a successful asynchronous gate still prevents dispatch', async () => {
    let calls = 0; let syncChecks = 0;
    const controller = new AbortController();
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request, signal: controller.signal,
      beforeAsyncAttempt: async () => { await Promise.resolve(); controller.abort(); },
      beforeAttempt: () => { syncChecks++; },
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(0); expect(syncChecks).toBe(0);
  });

  test('synchronous final authority check can refuse a successfully completed asynchronous gate', async () => {
    let calls = 0; let allowed = true;
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request,
      beforeAsyncAttempt: async () => { await Promise.resolve(); allowed = false; },
      beforeAttempt: () => { if (!allowed) throw new Error('revoked while awaiting admission'); },
    })).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls).toBe(0);
  });

  test('every fallback and retry completes a fresh gate before its synchronous check and wire attempt', async () => {
    const steps: string[] = []; const urls: string[] = []; let gates = 0;
    const port = createSystemOnePort({ ...config(async (url) => {
      steps.push(`fetch ${gates}`); urls.push(String(url));
      return urls.length < 3 ? unavailable() : good();
    }), fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'fallback-key' }, model: PINNED_MODEL }] });
    const result = await port.ask({ ...request,
      beforeAsyncAttempt: async () => { const gate = ++gates; steps.push(`begin ${gate}`); await tick(); steps.push(`end ${gate}`); },
      beforeAttempt: () => { steps.push(`sync ${gates}`); },
    });
    expect(gates).toBe(3);
    expect(steps).toEqual([1, 2, 3].flatMap((gate) => [`begin ${gate}`, `end ${gate}`, `sync ${gate}`, `fetch ${gate}`]));
    expect(urls).toEqual(['http://127.0.0.1:1/v1/systemone', 'http://127.0.0.1:2/v1/systemone', 'http://127.0.0.1:1/v1/systemone']);
    expect(result.lineage?.attempts.map((attempt) => [attempt.endpointIndex, attempt.outcome])).toEqual([[0, 'unavailable'], [1, 'unavailable'], [0, 'answered']]);
  });

  test('denial after backoff prevents the next retry without altering prior attempt evidence', async () => {
    let calls = 0; let gates = 0; let allowed = true;
    const port = createSystemOnePort(config(async () => { calls++; return unavailable(); }));
    await expect(port.ask({ ...request,
      beforeAsyncAttempt: async () => { gates++; await Promise.resolve(); if (!allowed) throw new Error('permission changed'); },
      onRetry: () => { allowed = false; },
    })).rejects.toMatchObject({ kind: 'rejected', lineage: { attempts: [{ attempt: 1, outcome: 'unavailable' }] } });
    expect(gates).toBe(2); expect(calls).toBe(1);
    expect(port.health?.()[0]?.attempts).toBe(1);
  });

  test('a cancelled pending retry admission cannot dispatch when it later resolves', async () => {
    let calls = 0; let gates = 0;
    const controller = new AbortController(); const retryEntered = deferred<void>(); const release = deferred<void>();
    const port = createSystemOnePort({ ...config(async () => { calls++; return unavailable(); }),
      fallbacks: [{ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:2', apiKey: 'fallback-key' }, model: PINNED_MODEL }],
    });
    const pending = port.ask({ ...request, signal: controller.signal, beforeAsyncAttempt: async () => {
      if (++gates === 2) { retryEntered.resolve(); await release.promise; }
    } });
    await retryEntered.promise;
    expect(calls).toBe(1); controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', lineage: { attempts: [{ attempt: 1, outcome: 'unavailable' }] } });
    release.resolve(); await tick();
    expect(gates).toBe(2); expect(calls).toBe(1);
    expect(port.health?.().map((endpoint) => endpoint.attempts)).toEqual([1, 0]);
  });

  test('out-of-order admissions on separate calls never authorize the other call', async () => {
    const firstEntered = deferred<void>(); const firstRelease = deferred<void>();
    const transmitted: unknown[] = []; let firstAllowed = true;
    const port = createSystemOnePort(config(async (_url, init) => { transmitted.push(JSON.parse(String(init?.body)).state); return good(); }));
    const first = port.ask({ ...request, state: 'first', beforeAsyncAttempt: async () => {
      firstEntered.resolve(); await firstRelease.promise; if (!firstAllowed) throw new Error('first revoked');
    } });
    await firstEntered.promise;
    await port.ask({ ...request, state: 'second', beforeAsyncAttempt: async () => { await Promise.resolve(); } });
    expect(transmitted).toEqual(['second']);
    firstAllowed = false; firstRelease.resolve();
    await expect(first).rejects.toMatchObject({ kind: 'rejected' });
    expect(transmitted).toEqual(['second']);
  });

  test('admission wait does not consume the per-wire-attempt timeout or create outage retries', async () => {
    const entered = deferred<void>(); const release = deferred<void>(); let calls = 0; let retries = 0;
    const port = createSystemOnePort({ ...config(async () => { calls++; return good(); }), timeoutMs: 10 });
    const pending = port.ask({ ...request, beforeAsyncAttempt: async () => { entered.resolve(); await release.promise; }, onRetry: () => { retries++; } });
    await entered.promise; await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0); expect(retries).toBe(0); release.resolve();
    expect((await pending).answers.yes.noul).toBe(0.9);
    expect(calls).toBe(1); expect(retries).toBe(0);
  });

  test('a promise returned by the legacy synchronous guard still fails closed', async () => {
    let calls = 0; let asyncCalls = 0;
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request, beforeAsyncAttempt: async () => { asyncCalls++; },
      beforeAttempt: async () => { throw new Error('legacy async guard'); },
    })).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(asyncCalls).toBe(1); expect(calls).toBe(0);
  });
});
