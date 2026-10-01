/**
 * fleet-focus-link.ts, fragment parse + history cleanup for a push
 * "needs-input" hand-off (a fleet node blocked on the operator).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { parseFleetFocusFromHash, stripFleetFocusFragment } from './fleet-focus-link';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('parseFleetFocusFromHash', () => {
  test('reads a node + session intent', () => {
    expect(parseFleetFocusFromHash('#fleet-node=agent-7&fleet-session=s-1')).toEqual({
      nodeId: 'agent-7',
      sessionId: 's-1',
    });
  });

  test('reads a node-only intent (no session carried)', () => {
    expect(parseFleetFocusFromHash('#fleet-node=agent-7')).toEqual({ nodeId: 'agent-7' });
  });

  test('decodes encoded ids', () => {
    expect(parseFleetFocusFromHash('#fleet-node=a%2Fb&fleet-session=x%20y')).toEqual({
      nodeId: 'a/b',
      sessionId: 'x y',
    });
  });

  test('returns null without a node id, or for an unrelated / empty hash', () => {
    expect(parseFleetFocusFromHash('#fleet-session=s-1')).toBeNull();
    expect(parseFleetFocusFromHash('#fleet-node=')).toBeNull();
    expect(parseFleetFocusFromHash('#view=chat')).toBeNull();
    expect(parseFleetFocusFromHash('')).toBeNull();
  });
});

describe('stripFleetFocusFragment', () => {
  test('removes only the fleet-focus keys, keeping path, query, and other fragment keys', () => {
    window.history.replaceState(null, '', '/?view=fleet#view=chat&fleet-node=agent-7&fleet-session=s-1');
    stripFleetFocusFragment();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?view=fleet');
    expect(window.location.hash).toBe('#view=chat');
    expect(parseFleetFocusFromHash(window.location.hash)).toBeNull();
  });

  test('clears the fragment entirely when the focus keys were the only ones', () => {
    window.history.replaceState(null, '', '/?view=fleet#fleet-node=agent-7&fleet-session=s-1');
    stripFleetFocusFragment();
    expect(window.location.hash).toBe('');
  });

  test('is a no-op when there is no focus fragment', () => {
    window.history.replaceState(null, '', '/?view=fleet');
    stripFleetFocusFragment();
    expect(window.location.search).toBe('?view=fleet');
  });
});
