/**
 * The turn's input surface is scoped to that turn's async work, so two
 * concurrent turns in one process each see their own surface, and nothing
 * outside a turn sees one.
 */
import { describe, expect, test } from 'bun:test';
import { currentTurnSurfaceId, turnSurfaceOf, withTurnSurface } from '../sdk/src/platform/security/turn-boundary.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('turn surface scope', () => {
  test('owner-direct input has no surface; other input names its surface', () => {
    expect(turnSurfaceOf(undefined)).toBeUndefined();
    expect(turnSurfaceOf({ source: 'operator' })).toBeUndefined();
    expect(turnSurfaceOf({ surface: 'email', ownerDirect: false })).toBe('email');
    expect(turnSurfaceOf({ source: 'webhook' })).toBe('webhook');
  });

  test('concurrent turns keep their own surface across awaits; outside a turn there is none', async () => {
    const seen = await Promise.all([
      withTurnSurface({ surface: 'email' }, async () => { await sleep(20); return currentTurnSurfaceId(); }),
      withTurnSurface(undefined, async () => { await sleep(5); return currentTurnSurfaceId(); }),
      withTurnSurface({ surface: 'telegram' }, async () => { await Promise.resolve(); return currentTurnSurfaceId(); }),
    ]);
    expect(seen).toEqual(['email', undefined, 'telegram']);
    expect(currentTurnSurfaceId()).toBeUndefined();
  });
});
