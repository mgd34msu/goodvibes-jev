import { describe, expect, test } from 'bun:test';
import {
  allowTerminalWrite,
  installTerminalOutputGuard,
  type TerminalOutputIntercept,
} from '@goodvibes-jev/engine/terminal-shell';
import { allowTerminalWrite as rendererWrite } from '@goodvibes-jev/engine/terminal-shell/terminal-write';

function makeStream() {
  const writes: string[] = [];
  return {
    writes,
    write: (...args: unknown[]) => {
      writes.push(String(args[0] ?? ''));
      const maybeCallback = args[args.length - 1];
      if (typeof maybeCallback === 'function') {
        maybeCallback(null);
      }
      return true;
    },
  };
}

describe('terminal output guard', () => {
  test('captures direct stdout, stderr, and console writes while active', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      stdout.write('raw stdout\n');
      stderr.write('raw stderr\n');
      console.error('console %s', 'error');

      expect(stdout.writes).toEqual([]);
      expect(stderr.writes).toEqual([]);
      expect(captured.map((event) => event.source)).toEqual([
        'stdout',
        'stderr',
        'console.error',
      ]);
      expect(captured[2]?.preview).toBe('console error');
    } finally {
      guard.dispose();
    }
  });

  test('allows compositor-owned writes through allowTerminalWrite', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      expect(rendererWrite).toBe(allowTerminalWrite);
      allowTerminalWrite(() => stdout.write('render diff'));
      rendererWrite(() => stdout.write('next frame'));
      expect(() => rendererWrite(() => { throw new Error('frame stopped'); })).toThrow('frame stopped');
      stdout.write('unowned write');

      expect(stdout.writes).toEqual(['render diff', 'next frame']);
      expect(captured.map(event => event.text)).toEqual(['unowned write']);
    } finally {
      guard.dispose();
    }
    rendererWrite(() => stdout.write('after disposal'));
    expect(stdout.writes.at(-1)).toBe('after disposal');
  });

  test('passes writes through after being deactivated', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      guard.setActive(false);
      stdout.write('normal stdout');
      stderr.write('normal stderr');

      expect(stdout.writes).toEqual(['normal stdout']);
      expect(stderr.writes).toEqual(['normal stderr']);
      expect(captured).toEqual([]);
    } finally {
      guard.dispose();
    }
  });
});
