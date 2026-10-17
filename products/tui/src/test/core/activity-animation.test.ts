import { expect, spyOn, test } from 'bun:test';
import { ActivityAnimation } from '../../core/activity-animation.ts';
import { SPINNER_FRAMES } from '../../renderer/ui-primitives.ts';

test('activity animates without a model timer and stops at rest or disposal', () => {
  let tick: (() => void) | undefined;
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  const start = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;
    return timer;
  }) as typeof setInterval);
  const stop = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const drawn: string[] = [];
  const animation = new ActivityAnimation(() => drawn.push(SPINNER_FRAMES[animation.frame % SPINNER_FRAMES.length]!));
  try {
    animation.setActive(true);
    tick!();
    animation.setActive(true);
    tick!();
    expect(start).toHaveBeenCalledTimes(1);
    expect(drawn).toEqual(['⠙', '⠹']);

    animation.setActive(false);
    expect(stop).toHaveBeenCalledWith(timer);
    expect(animation.frame).toBe(0);
    tick!();
    expect(drawn).toHaveLength(2);
    animation.setActive(true);
    expect(start).toHaveBeenCalledTimes(2);
    animation.dispose();
    tick!();
    expect(drawn).toHaveLength(2);
    animation.setActive(true);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenLastCalledWith(timer);
  } finally {
    animation.dispose();
    start.mockRestore();
    stop.mockRestore();
  }
});
