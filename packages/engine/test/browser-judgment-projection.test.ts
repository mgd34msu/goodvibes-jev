import { describe, expect, test } from 'bun:test';
import { BrowserJudgmentError, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { validateBrowserJudgmentProjection } from '../sdk/src/platform/judgment-browser/projection.ts';
import type { BrowserJudgmentProjection } from '../sdk/src/platform/judgment-browser/types.ts';

const unknownReading = { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' } as const;
const request = (battery: string, input: unknown) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: 1, input }) as BrowserJudgmentRequest;
const check = (req: BrowserJudgmentRequest, projection: unknown, state?: unknown) => validateBrowserJudgmentProjection(req, projection as BrowserJudgmentProjection<unknown>, state);
const held = (readings: unknown) => ({ status: 'held', reason: 'uncertain', readings });
const errorNames = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'];

describe('closed held projections', () => {
  test('held errors require all five fixed yes/no reading names', () => {
    const req = request('webui.errors.daemon-refusal', { errorRef: 'fixture' });
    const readings = Object.fromEntries(errorNames.map((name) => [name, unknownReading]));
    expect(() => check(req, held(readings))).not.toThrow();
    for (const bad of [{ private_state: unknownReading }, { ...readings, private_state: unknownReading }, { ...readings, method_unknown: undefined }]) {
      expect(() => check(req, held(bad))).toThrow(BrowserJudgmentError);
    }
  });
  test('held status names, choices, and probabilities use only the selected vocabulary', () => {
    for (const vocabulary of ['badge', 'library-dot']) {
      const req = request('webui.status.badge-tone', { vocabulary, source: { kind: 'catalog', labelId: 'fixture' } });
      const key = vocabulary === 'badge' ? 'badge' : 'library_dot';
      const tones = vocabulary === 'badge' ? ['ok', 'warning', 'bad', 'neutral'] : ['ok', 'warn', 'bad', 'info', 'idle'];
      const reading = { kind: 'choice', choice: 'ok', confidence: 0.5, outcome: 'escalate', probabilities: Object.fromEntries(tones.map((tone) => [tone, 1 / tones.length])) };
      expect(() => check(req, held({ [key]: reading }))).not.toThrow();
      for (const bad of [
        { private_state: reading },
        { [key]: { ...reading, choice: 'private_state' } },
        { [key]: { ...reading, probabilities: { private_state: 0.5, other: 0.5 } } },
        { [key]: { ...reading, private_state: 'synthetic-private' } },
      ]) expect(() => check(req, held(bad))).toThrow(BrowserJudgmentError);
    }
  });
  test('held palette readings are complete opaque candidate indices', () => {
    const req = request('webui.palette.command-rank', { query: { kind: 'inline', text: 'fixture' }, registryVersion: 'v1', candidates: [{ kind: 'builtin', commandId: 'a' }, { kind: 'builtin', commandId: 'b' }] });
    expect(() => check(req, held({ candidate_0: unknownReading, candidate_1: unknownReading }))).not.toThrow();
    for (const readings of [{ candidate_0: unknownReading }, { private_state: unknownReading, candidate_1: unknownReading },
      { candidate_0: unknownReading, candidate_1: { ...unknownReading, probability: NaN } }]) expect(() => check(req, held(readings))).toThrow(BrowserJudgmentError);
  });
});
