/**
 * knowledge-projection.test.ts
 *
 * Every check below has a case where the honest answer is "no". The two the
 * 1.19.1 re-pin exists to expose are the ones worth stating plainly:
 *
 *   - a kind this build has never heard of must NOT be sent, and must not be
 *     reported as a generic request failure either;
 *   - an issue/node/rollup/source projection with no id must NOT be sent, since
 *     the contract's own discriminated union requires one and the daemon was
 *     already refusing it.
 *
 * Both used to compile and ship, because the pre-1.19.1 input type for this
 * method was a permissive index signature.
 */
import { describe, expect, test } from 'bun:test';
import {
  PROJECTION_KIND_NEEDS_ID,
  asProjectionKind,
  kindNeedsId,
  projectionPayload,
  type ProjectionKind,
} from './knowledge-projection';

const ID_OPTIONAL: readonly ProjectionKind[] = ['bundle', 'dashboard', 'overview'];
const ID_REQUIRED: readonly ProjectionKind[] = ['issue', 'node', 'rollup', 'source'];

/** Object.keys widens to string[]; the table's keys ARE the ProjectionKind union. */
function tableKinds(): ProjectionKind[] {
  return Object.keys(PROJECTION_KIND_NEEDS_ID) as ProjectionKind[];
}

describe('asProjectionKind: recognises exactly the contract set, and nothing else', () => {
  test('every kind in the table round-trips', () => {
    for (const kind of tableKinds()) {
      expect(asProjectionKind(kind)).toBe(kind);
    }
  });

  test('a kind the contract does not carry answers null', () => {
    // The case that matters: a daemon newer than this client offering something new.
    expect(asProjectionKind('timeline')).toBeNull();
    expect(asProjectionKind('')).toBeNull();
    expect(asProjectionKind('SOURCE')).toBeNull();
  });

  test('an inherited Object property is not mistaken for a kind', () => {
    // hasOwnProperty, not `in`, otherwise 'toString' and 'constructor' would
    // both read as valid projection kinds and be sent to the daemon.
    expect(asProjectionKind('toString')).toBeNull();
    expect(asProjectionKind('constructor')).toBeNull();
    expect(asProjectionKind('hasOwnProperty')).toBeNull();
  });
});

describe('kindNeedsId: matches the contract, in both directions', () => {
  test('issue/node/rollup/source require an id', () => {
    for (const kind of ID_REQUIRED) expect(kindNeedsId(kind)).toBe(true);
  });

  test('bundle/dashboard/overview do not', () => {
    for (const kind of ID_OPTIONAL) expect(kindNeedsId(kind)).toBe(false);
  });

  test('the two groups together are the whole table, no kind is unclassified', () => {
    expect([...ID_OPTIONAL, ...ID_REQUIRED].sort()).toEqual(tableKinds().sort());
  });
});

describe('projectionPayload: refuses rather than sending something the daemon rejects', () => {
  test('an id-optional kind builds a payload with no id, even when one is available', () => {
    expect(projectionPayload({ kind: 'overview', renderableKind: 'overview', id: 'ignored' }, 10)).toEqual({
      kind: 'overview',
      limit: 10,
    });
  });

  test('an id-requiring kind carries its id', () => {
    expect(projectionPayload({ kind: 'source', renderableKind: 'source', id: 'src-1' }, 5)).toEqual({
      kind: 'source',
      id: 'src-1',
      limit: 5,
    });
  });

  test('the default limit is applied when the caller does not pass one', () => {
    expect(projectionPayload({ kind: 'bundle', renderableKind: 'bundle' })).toEqual({ kind: 'bundle', limit: 25 });
  });

  test('an unknown kind throws, naming the kind rather than failing generically', () => {
    expect(() => projectionPayload({ kind: 'timeline', renderableKind: null })).toThrow(/"timeline"/);
  });

  test('an id-requiring kind with no id throws', () => {
    for (const kind of ID_REQUIRED) {
      expect(() => projectionPayload({ kind, renderableKind: kind })).toThrow();
    }
  });

  test('an id-requiring kind with an EMPTY id is treated as missing, not sent as ""', () => {
    expect(() => projectionPayload({ kind: 'node', renderableKind: 'node', id: '' })).toThrow(
      /has to name the item it projects/,
    );
  });

  test('an id-optional kind with no id does NOT throw (the refusal is narrow, not blanket)', () => {
    for (const kind of ID_OPTIONAL) {
      expect(() => projectionPayload({ kind, renderableKind: kind })).not.toThrow();
    }
  });
});
