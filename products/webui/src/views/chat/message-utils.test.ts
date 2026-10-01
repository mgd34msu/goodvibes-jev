/**
 * Unit tests for the tool-activity helpers in message-utils.ts:
 * toolFriendlyLabel, toolKeyArg, toolResultText, describeToolActivity, the
 * message time rules, and the working and settled turn labels.
 *
 * These back the folded tool-call rendering (ToolActivityGroup), the platform-
 * wide "keep tool results, fold them" fix applied to the webui.
 */
import { describe, expect, test } from 'bun:test';
import {
  toolFriendlyLabel,
  toolKeyArg,
  toolResultText,
  messageTimeMs,
  messageTimestamp,
  describeToolActivity,
  formatToolDuration,
  workingStatusLabel,
  settledTurnLabel,
} from './message-utils';

describe('toolFriendlyLabel', () => {
  test('maps known tool names case-insensitively, grouping tools of one kind under one label', () => {
    expect(toolFriendlyLabel('BASH')).toBe(toolFriendlyLabel('bash'));
    expect(toolFriendlyLabel('bash')).not.toBe('bash');
    expect(toolFriendlyLabel('Grep')).toBe(toolFriendlyLabel('Glob'));
    expect(toolFriendlyLabel('Grep')).not.toBe(toolFriendlyLabel('bash'));
  });

  test('falls back to the raw tool name for an unrecognized tool', () => {
    expect(toolFriendlyLabel('CustomMcpTool')).toBe('CustomMcpTool');
  });

  test('an empty/whitespace name still yields a non-empty label', () => {
    expect(toolFriendlyLabel('').length).toBeGreaterThan(0);
    expect(toolFriendlyLabel('   ')).toBe(toolFriendlyLabel(''));
  });
});

describe('toolKeyArg', () => {
  test('extracts file_path when present', () => {
    expect(toolKeyArg({ file_path: '/tmp/foo.ts' })).toBe('/tmp/foo.ts');
  });

  test('extracts command when file_path is absent', () => {
    expect(toolKeyArg({ command: 'ls -la' })).toBe('ls -la');
  });

  test('checks fields in priority order (file_path before command)', () => {
    expect(toolKeyArg({ file_path: '/a.ts', command: 'ls' })).toBe('/a.ts');
  });

  test('returns empty string when no known field is present', () => {
    expect(toolKeyArg({ unrelatedField: 123 })).toBe('');
  });

  test('returns empty string for non-object input', () => {
    expect(toolKeyArg('just a string')).toBe('');
    expect(toolKeyArg(undefined)).toBe('');
    expect(toolKeyArg(null)).toBe('');
  });

  test('ignores a blank string value and keeps looking', () => {
    expect(toolKeyArg({ file_path: '   ', command: 'ls' })).toBe('ls');
  });
});

describe('toolResultText', () => {
  test('a string result passes through unchanged', () => {
    expect(toolResultText('plain text result')).toBe('plain text result');
  });

  test('an object result renders as compact JSON', () => {
    const text = toolResultText({ ok: true, count: 3 });
    expect(text).toContain('"ok": true');
    expect(text).toContain('"count": 3');
  });

  test('undefined/null render as empty string, never "undefined"/"null"', () => {
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText(null)).toBe('');
  });

  test('a numeric/boolean result stringifies honestly', () => {
    expect(toolResultText(42)).toBe('42');
    expect(toolResultText(false)).toBe('false');
  });
});

describe('messageTimeMs / messageTimestamp: never an epoch date', () => {
  test('zero, negative, missing and non-numeric times are missing (null / empty)', () => {
    for (const value of [0, -5, undefined, null, '', 'not a date', Number.NaN]) {
      expect(messageTimeMs({ createdAt: value })).toBeNull();
      expect(messageTimestamp({ createdAt: value })).toBe('');
    }
    expect(messageTimestamp({})).toBe('');
  });

  test('a tiny value (1 second after the epoch, a counter) is missing, not 1969', () => {
    expect(messageTimeMs({ createdAt: 1000 })).toBeNull();
    expect(messageTimestamp({ createdAt: 1000 })).toBe('');
  });

  test('epoch milliseconds, epoch seconds and ISO strings all resolve', () => {
    const ms = Date.UTC(2026, 8, 30, 12, 0);
    expect(messageTimeMs({ createdAt: ms })).toBe(ms);
    expect(messageTimeMs({ timestamp: ms / 1000 })).toBe(ms);
    expect(messageTimeMs({ time: new Date(ms).toISOString() })).toBe(ms);
    expect(messageTimeMs({ createdAt: String(ms) })).toBe(ms);
  });

  test('today shows only the time; an earlier day adds the date', () => {
    const now = new Date(2026, 8, 30, 18, 0).getTime();
    const today = messageTimestamp({ createdAt: new Date(2026, 8, 30, 15, 42).getTime() }, now);
    const earlier = messageTimestamp({ createdAt: new Date(2026, 8, 28, 15, 42).getTime() }, now);
    expect(today).toMatch(/42/);
    expect(today).not.toMatch(/28/);
    expect(earlier).toMatch(/28/);
    expect(earlier).not.toMatch(/2026/);
    const lastYear = messageTimestamp({ createdAt: new Date(2025, 8, 28, 15, 42).getTime() }, now);
    expect(lastYear).toMatch(/2025/);
  });
});

describe('describeToolActivity: the collapsed tool line', () => {
  test('carries the real count of repeated calls', () => {
    expect(describeToolActivity([
      { toolCallId: '1', toolName: 'Read', isError: false },
      { toolCallId: '2', toolName: 'read', isError: false },
      { toolCallId: '3', toolName: 'WebSearch', isError: false },
    ])).toContain('2');
  });

  test('unknown tools are named, with a count when repeated', () => {
    expect(describeToolActivity([{ toolCallId: '1', toolName: 'calendar_list', isError: false }])).toContain('calendar_list');
    const repeated = describeToolActivity([
      { toolCallId: '1', toolName: 'mail', isError: false },
      { toolCallId: '2', toolName: 'mail', isError: false },
    ]);
    expect(repeated).toContain('mail');
    expect(repeated).toContain('2');
  });

  test('failures are counted; the duration appears only when timed', () => {
    const plain = describeToolActivity([{ toolCallId: '1', toolName: 'bash', isError: false }]);
    expect(describeToolActivity([{ toolCallId: '1', toolName: 'bash', isError: true }])).not.toBe(plain);
    const timed = describeToolActivity([
      { toolCallId: '1', toolName: 'bash', isError: false, startedAt: 10_000, finishedAt: 14_400 },
    ]);
    expect(timed).not.toBe(plain);
    expect(timed).toContain(formatToolDuration(4_400));
  });

  test('empty input is an empty line', () => {
    expect(describeToolActivity([])).toBe('');
  });
});

describe('formatToolDuration', () => {
  test('sub-second, seconds and minutes', () => {
    expect(formatToolDuration(300)).toBe('<1 s');
    expect(formatToolDuration(4_200)).toBe('4 s');
    expect(formatToolDuration(72_000)).toBe('1 min 12 s');
    expect(formatToolDuration(120_000)).toBe('2 min');
  });
});

describe('workingStatusLabel: the line under the last message', () => {
  test('running tools change the line and carry their count', () => {
    expect(workingStatusLabel('tooling', ['read', 'read'], false)).toContain('2');
    expect(workingStatusLabel('tooling', ['bash'], false)).not.toBe(workingStatusLabel('tooling', ['read'], false));
  });

  test('every active turn state has a line; idle has none', () => {
    for (const state of ['sending', 'submitted', 'running', 'reconnecting', 'stopping'] as const) {
      expect(workingStatusLabel(state, [], false).length).toBeGreaterThan(0);
    }
    expect(workingStatusLabel('streaming', [], true).length).toBeGreaterThan(0);
    expect(workingStatusLabel('idle', [], false)).toBe('');
  });
});

describe('settledTurnLabel', () => {
  test('a line for a turn that ended badly, nothing for normal states', () => {
    expect(settledTurnLabel('stream paused').length).toBeGreaterThan(0);
    expect(settledTurnLabel('send failed').length).toBeGreaterThan(0);
    expect(settledTurnLabel('completed')).toBe('');
    expect(settledTurnLabel('streaming')).toBe('');
    expect(settledTurnLabel('idle')).toBe('');
  });
});
