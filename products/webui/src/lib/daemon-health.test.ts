import { describe, expect, test } from 'bun:test';
import {
  taskCountsFromList,
  modelNameFromCurrent,
  clampLatency,
  formatLatency,
  connectionLabel,
  authLabel,
  workingLabel,
  deriveAuthState,
  deriveWorkingState,
  sseLabel,
  routeLabel,
} from './daemon-health';

// ---------------------------------------------------------------------------
// taskCountsFromList
// ---------------------------------------------------------------------------

describe('taskCountsFromList', () => {
  // Null / non-object guard
  test('returns zeros for null', () => {
    expect(taskCountsFromList(null)).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for undefined', () => {
    expect(taskCountsFromList(undefined)).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for a string', () => {
    expect(taskCountsFromList('not an object')).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for a number', () => {
    expect(taskCountsFromList(42)).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for an empty object (no tasks/items/data key)', () => {
    expect(taskCountsFromList({})).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros when items field is not an array', () => {
    expect(taskCountsFromList({ tasks: 'invalid' })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  // Empty arrays
  test('returns zeros for empty tasks array', () => {
    expect(taskCountsFromList({ tasks: [] })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for empty items array', () => {
    expect(taskCountsFromList({ items: [] })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('returns zeros for empty data array', () => {
    expect(taskCountsFromList({ data: [] })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  // Active status values via `status` field
  test('counts status=running as activeTurns', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'running' }] })).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  test('counts status=active as activeTurns', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'active' }] })).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  test('counts status=in_progress as activeTurns', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'in_progress' }] })).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  // Queued status values via `status` field
  test('counts status=queued as queuedTasks', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'queued' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });

  test('counts status=pending as queuedTasks', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'pending' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });

  test('counts status=waiting as queuedTasks', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'waiting' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });

  // Status is case-insensitive (lowercased internally)
  test('handles uppercase status values', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'RUNNING' }, { status: 'QUEUED' }] })).toEqual({ activeTurns: 1, queuedTasks: 1 });
  });

  // `state` field used when `status` is absent
  test('falls back to state field when status is missing', () => {
    expect(taskCountsFromList({ tasks: [{ state: 'running' }] })).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  test('counts state=pending as queuedTasks', () => {
    expect(taskCountsFromList({ tasks: [{ state: 'pending' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });

  // status takes precedence over state
  test('prefers status field over state field', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'queued', state: 'running' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });

  // Unknown status is ignored
  test('ignores unknown status values', () => {
    expect(taskCountsFromList({ tasks: [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }] })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  test('ignores items with no status or state', () => {
    expect(taskCountsFromList({ tasks: [{}] })).toEqual({ activeTurns: 0, queuedTasks: 0 });
  });

  // Mixed bag
  test('counts mixed active, queued, and unknown tasks correctly', () => {
    const response = {
      tasks: [
        { status: 'running' },
        { status: 'active' },
        { status: 'in_progress' },
        { status: 'queued' },
        { status: 'pending' },
        { status: 'waiting' },
        { status: 'done' },
        {},
      ],
    };
    expect(taskCountsFromList(response)).toEqual({ activeTurns: 3, queuedTasks: 3 });
  });

  // Array key priority: tasks > items > data
  test('prefers tasks key over items key', () => {
    const response = {
      tasks: [{ status: 'running' }],
      items: [{ status: 'queued' }, { status: 'queued' }],
    };
    expect(taskCountsFromList(response)).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  test('prefers items key over data key', () => {
    const response = {
      items: [{ status: 'active' }],
      data: [{ status: 'pending' }, { status: 'pending' }],
    };
    expect(taskCountsFromList(response)).toEqual({ activeTurns: 1, queuedTasks: 0 });
  });

  test('falls back to data key when tasks and items are absent', () => {
    expect(taskCountsFromList({ data: [{ status: 'pending' }] })).toEqual({ activeTurns: 0, queuedTasks: 1 });
  });
});

// ---------------------------------------------------------------------------
// modelNameFromCurrent
// ---------------------------------------------------------------------------

describe('modelNameFromCurrent', () => {
  test('returns null for null', () => {
    expect(modelNameFromCurrent(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(modelNameFromCurrent(undefined)).toBeNull();
  });

  test('returns null for a string', () => {
    expect(modelNameFromCurrent('claude')).toBeNull();
  });

  test('returns null for a number', () => {
    expect(modelNameFromCurrent(0)).toBeNull();
  });

  test('returns null for an empty object', () => {
    expect(modelNameFromCurrent({})).toBeNull();
  });

  test('returns displayName when present', () => {
    expect(modelNameFromCurrent({ displayName: 'Claude 3 Opus', name: 'opus', registryKey: 'rk', id: 'id-1' })).toBe('Claude 3 Opus');
  });

  test('returns name when displayName is absent', () => {
    expect(modelNameFromCurrent({ name: 'opus', registryKey: 'rk', id: 'id-1' })).toBe('opus');
  });

  test('returns registryKey when displayName and name are absent', () => {
    expect(modelNameFromCurrent({ registryKey: 'claude-opus-4', id: 'id-1' })).toBe('claude-opus-4');
  });

  test('returns id when only id is present', () => {
    expect(modelNameFromCurrent({ id: 'model-abc' })).toBe('model-abc');
  });

  test('returns null when all name fields are absent', () => {
    expect(modelNameFromCurrent({ version: 1, extra: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clampLatency
// ---------------------------------------------------------------------------

describe('clampLatency', () => {
  test('returns null for negative values (clock skew)', () => {
    expect(clampLatency(-1)).toBeNull();
  });

  test('returns null for large negative values', () => {
    expect(clampLatency(-9999)).toBeNull();
  });

  test('returns 0 for zero', () => {
    expect(clampLatency(0)).toBe(0);
  });

  test('returns value unchanged for mid-range latency', () => {
    expect(clampLatency(250)).toBe(250);
  });

  test('returns 9999 for exactly 9999', () => {
    expect(clampLatency(9999)).toBe(9999);
  });

  test('clamps values above 9999 to 9999', () => {
    expect(clampLatency(10000)).toBe(9999);
  });

  test('clamps very large values to 9999', () => {
    expect(clampLatency(999999)).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// formatLatency
// ---------------------------------------------------------------------------

describe('formatLatency', () => {
  test('returns em-dash for null', () => {
    expect(formatLatency(null)).toBe('—');
  });

  test('returns <10ms for 0', () => {
    expect(formatLatency(0)).toBe('<10ms');
  });

  test('returns <10ms for 1', () => {
    expect(formatLatency(1)).toBe('<10ms');
  });

  test('returns <10ms for 9', () => {
    expect(formatLatency(9)).toBe('<10ms');
  });

  test('returns Xms for exactly 10', () => {
    expect(formatLatency(10)).toBe('10ms');
  });

  test('returns Xms for mid-range value', () => {
    expect(formatLatency(42)).toBe('42ms');
  });

  test('returns Xms for 999', () => {
    expect(formatLatency(999)).toBe('999ms');
  });

  test('returns X.Xs for exactly 1000', () => {
    expect(formatLatency(1000)).toBe('1.0s');
  });

  test('returns X.Xs for 1200', () => {
    expect(formatLatency(1200)).toBe('1.2s');
  });

  test('returns X.Xs for 9999', () => {
    expect(formatLatency(9999)).toBe('10.0s');
  });
});

// ---------------------------------------------------------------------------
// deriveAuthState / deriveWorkingState, the axes can disagree; 401 never = ok
// ---------------------------------------------------------------------------

describe('deriveAuthState', () => {
  test('200 → signed-in', () => {
    expect(deriveAuthState({ ok: true, status: 200 })).toBe('signed-in');
  });
  test('401 → signed-out (not unknown)', () => {
    expect(deriveAuthState({ ok: false, status: 401 })).toBe('signed-out');
  });
  test('other failure (5xx/network) → unknown, not a false signed-out', () => {
    expect(deriveAuthState({ ok: false, status: 503 })).toBe('unknown');
    expect(deriveAuthState({ ok: false, status: null })).toBe('unknown');
  });
});

describe('deriveWorkingState', () => {
  test('authed read succeeds → working', () => {
    expect(deriveWorkingState({ ok: true, status: 200 })).toBe('working');
  });
  test('401 on the authed read → blocked (signed-out OR missing read:sessions scope)', () => {
    expect(deriveWorkingState({ ok: false, status: 401 })).toBe('blocked');
  });
  test('other failure → unknown', () => {
    expect(deriveWorkingState({ ok: false, status: 500 })).toBe('unknown');
    expect(deriveWorkingState({ ok: false, status: null })).toBe('unknown');
  });
  test('the three axes can disagree: reachable + signed-in but blocked (scope gap)', () => {
    // A reachable daemon with a signed-in token that lacks read:sessions must NOT
    // read as "working".
    expect(deriveAuthState({ ok: true, status: 200 })).toBe('signed-in');
    expect(deriveWorkingState({ ok: false, status: 401 })).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// label helpers: every state is distinguishable from every other
// ---------------------------------------------------------------------------

describe('label helpers', () => {
  function distinct(labels: readonly string[]): void {
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  }

  test('each helper gives every state it is handed a distinct, non-empty label', () => {
    distinct([connectionLabel('connected'), connectionLabel('reconnecting'), connectionLabel('down')]);
    distinct([authLabel('signed-in'), authLabel('signed-out'), authLabel('unknown')]);
    distinct([workingLabel('working'), workingLabel('blocked'), workingLabel('unknown')]);
    distinct([sseLabel('active'), sseLabel('connecting'), sseLabel('error'), sseLabel('disabled'), sseLabel('relay-unsupported')]);
    distinct([routeLabel('direct'), routeLabel('relay'), routeLabel(null)]);
  });
});
