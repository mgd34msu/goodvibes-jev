import { describe, expect, test } from 'bun:test';
import { computeFloatingPosition } from './overlay';

const viewport = { width: 1000, height: 800 };
function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('computeFloatingPosition', () => {
  test('places bottom-start under the anchor with the gap', () => {
    const p = computeFloatingPosition(rect(100, 100, 80, 30), { width: 200, height: 100 }, 'bottom-start', viewport, 6);
    expect(p).toEqual({ top: 136, left: 100, placement: 'bottom-start' });
  });

  test('flips to the top when there is no room below', () => {
    const p = computeFloatingPosition(rect(100, 740, 80, 30), { width: 200, height: 120 }, 'bottom-start', viewport, 6);
    expect(p.placement).toBe('top-start');
    expect(p.top).toBe(740 - 6 - 120);
  });

  test('keeps a top menu (the account menu) above its trigger', () => {
    const p = computeFloatingPosition(rect(10, 740, 240, 44), { width: 280, height: 400 }, 'top-start', viewport, 6);
    expect(p.placement).toBe('top-start');
    expect(p.top + 400).toBeLessThanOrEqual(740);
  });

  test('clamps inside the viewport with an 8px margin', () => {
    const p = computeFloatingPosition(rect(950, 100, 40, 30), { width: 200, height: 100 }, 'bottom-start', viewport, 6);
    expect(p.left).toBe(1000 - 8 - 200);
  });

  test('a right tooltip that would overflow flips to the left', () => {
    const p = computeFloatingPosition(rect(900, 100, 40, 30), { width: 120, height: 24 }, 'right', viewport, 6);
    expect(p.placement).toBe('left');
    expect(p.left).toBe(900 - 6 - 120);
  });
});
