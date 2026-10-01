/**
 * wake-chime.ts, the sound a confirmed wake makes.
 *
 * Worth its own tests for one reason: the host reports "this tab could not play the
 * activation chime" based on this function's return value, so a chime that silently
 * failed while claiming to have played would make a silent wake look like a working
 * one. That is the state the whole activation-sound row exists to avoid.
 */
import { describe, expect, test } from 'bun:test';
import { playWakeChime, type ChimeAudioContext } from './wake-chime';

interface Recorded {
  context: ChimeAudioContext;
  oscillators: { hz: number; startedAt: number; stoppedAt: number; type: string }[];
  gains: { events: string[] }[];
  closed: boolean;
  resumed: number;
}

function fakeContext(options: { withEnvelope?: boolean } = {}): Recorded {
  const recorded: Recorded = { oscillators: [], gains: [], closed: false, resumed: 0, context: null as never };
  recorded.context = {
    currentTime: 10,
    destination: { kind: 'speakers' },
    createOscillator: () => {
      const entry = { hz: 0, startedAt: -1, stoppedAt: -1, type: '' };
      recorded.oscillators.push(entry);
      return {
        get type() { return entry.type; },
        set type(value: string) { entry.type = value; },
        frequency: {
          get value() { return entry.hz; },
          set value(hz: number) { entry.hz = hz; },
        },
        connect: () => undefined,
        start: (when?: number) => { entry.startedAt = when ?? 0; },
        stop: (when?: number) => { entry.stoppedAt = when ?? 0; },
      };
    },
    createGain: () => {
      const entry: { events: string[] } = { events: [] };
      recorded.gains.push(entry);
      const gain: ChimeAudioContext['createGain'] extends () => infer G ? G : never = {
        gain: {
          value: 1,
          ...(options.withEnvelope === false ? {} : {
            setValueAtTime: (value: number, when: number) => { entry.events.push(`set:${value}@${when}`); },
            linearRampToValueAtTime: (value: number, when: number) => { entry.events.push(`ramp:${value}@${when}`); },
          }),
        },
        connect: () => undefined,
      };
      return gain;
    },
    resume: () => {
      recorded.resumed += 1;
      return Promise.resolve();
    },
    close: () => {
      recorded.closed = true;
      return Promise.resolve();
    },
  };
  return recorded;
}

describe('playWakeChime', () => {
  test('schedules two rising notes and reports that it played', () => {
    const recorded = fakeContext();
    expect(playWakeChime(() => recorded.context)).toBe(true);
    expect(recorded.oscillators).toHaveLength(2);
    expect(recorded.oscillators[0].hz).toBeLessThan(recorded.oscillators[1].hz);
    expect(recorded.oscillators.every((entry) => entry.type === 'sine')).toBe(true);
    // Both notes are scheduled relative to the context's own clock, not from zero,
    // scheduling in the past plays nothing.
    for (const entry of recorded.oscillators) {
      expect(entry.startedAt).toBeGreaterThanOrEqual(10);
      expect(entry.stoppedAt).toBeGreaterThan(entry.startedAt);
    }
    // The second note overlaps into the first's tail rather than starting after a gap.
    expect(recorded.oscillators[1].startedAt).toBeLessThan(recorded.oscillators[0].stoppedAt);
  });

  test('each note gets a ramped envelope, so it is not an audible click', () => {
    const recorded = fakeContext();
    playWakeChime(() => recorded.context);
    expect(recorded.gains).toHaveLength(2);
    for (const gain of recorded.gains) {
      expect(gain.events[0]).toContain('set:0@');
      expect(gain.events.filter((event) => event.startsWith('ramp:'))).toHaveLength(2);
      // It ramps back to zero, so the note ends silent rather than being cut off.
      expect(gain.events[gain.events.length - 1]).toContain('ramp:0@');
    }
  });

  test('resumes the context, since a tab may hand back a suspended one', () => {
    const recorded = fakeContext();
    playWakeChime(() => recorded.context);
    expect(recorded.resumed).toBe(1);
  });

  test('a context without Web Audio scheduling still plays at a fixed gain', () => {
    const recorded = fakeContext({ withEnvelope: false });
    expect(playWakeChime(() => recorded.context)).toBe(true);
    expect(recorded.oscillators).toHaveLength(2);
  });

  test('no Web Audio at all reports FALSE rather than pretending a sound played', () => {
    // This is the value the host turns into "a wake confirmed but this tab could not
    // play the activation chime", the honest state, not a silent success.
    expect(playWakeChime(() => undefined)).toBe(false);
  });

  test('a context that throws mid-schedule reports false rather than escaping', () => {
    const broken: ChimeAudioContext = {
      currentTime: 0,
      destination: {},
      createOscillator: () => {
        throw new Error('no more oscillators');
      },
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
    };
    expect(playWakeChime(() => broken)).toBe(false);
  });
});
