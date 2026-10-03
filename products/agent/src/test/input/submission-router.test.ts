import { describe, expect, test } from 'bun:test';
import { routeSubmissionIntent } from '../../input/submission-router.ts';

describe('submission router', () => {
  test('classifies plain text as prompt', () => {
    expect(routeSubmissionIntent({ text: 'hello world' })).toMatchObject({
      kind: 'prompt',
      label: 'prompt',
    });
  });

  test('classifies slash planning commands', () => {
    expect(routeSubmissionIntent({ text: '/plan draft roadmap' })).toMatchObject({
      kind: 'plan',
      commandName: 'plan',
    });
  });

  test('classifies explicit delegation commands', () => {
    expect(routeSubmissionIntent({ text: '/delegate review bug bash' })).toMatchObject({
      kind: 'delegation',
      label: 'delegation',
      commandName: 'delegate',
    });
    expect(routeSubmissionIntent({ text: '/wrfc build this' })).toMatchObject({
      kind: 'delegation',
      commandName: 'wrfc',
    });
    expect(routeSubmissionIntent({ text: '/review this patch' })).toMatchObject({
      kind: 'delegation',
      commandName: 'review',
    });
  });

  test('classifies non-delegation orchestration commands separately', () => {
    expect(routeSubmissionIntent({ text: '/tasks list' })).toMatchObject({
      kind: 'orchestration',
      commandName: 'tasks',
    });
  });


  test('classifies shell shorthand and memory pin', () => {
    expect(routeSubmissionIntent({ text: '!git status' }).kind).toBe('shell');
    expect(routeSubmissionIntent({ text: '!# remember this' }).kind).toBe('memory-pin');
  });
});
