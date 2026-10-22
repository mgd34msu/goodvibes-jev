// ---------------------------------------------------------------------------
// throbber.test.ts, the row above the input area that says what main is
// doing, and the gaps that keep output text, the throbber, the input area and
// the status line from touching.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { buildShellFooter, type ShellFooterBuildOptions } from '../../renderer/shell-surface.ts';
import { renderThrobberLine, resolveThrobberActivity, type ThrobberActivity, type ThrobberActivityInput, type ThrobberState } from '../../renderer/throbber.ts';
import { renderToasts } from '../../renderer/surface-kit-parts.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { summarizeRunningAgents } from '../../renderer/process-summary.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

const NOW = 1_800_000_000_000;

function text(line: Line): string {
  return line.map((c) => c.char || '').join('');
}

/** The throbber's words as drawn on a row wide enough to hold all of them (text from column 5). */
function throbberText(state: { activity: ThrobberActivity; owner?: string }): string {
  return text(renderThrobberLine(240, { spinner: '⠋', frame: 0, ...state })).slice(5).trimEnd();
}

function footer(overrides: Partial<ShellFooterBuildOptions> = {}): Line[] {
  return buildShellFooter({
    width: 120,
    promptText: '',
    promptLineCount: 1,
    usage: { up: 53_000, down: 1_700 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/goodvibes-tui',
    branch: 'main',
    contextWindow: 1_000_000,
    compactThreshold: 0.8,
    lastInputTokens: 340_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    permissionMode: 'prompt',
    ...overrides,
  }).lines;
}

function input(overrides: Partial<ThrobberActivityInput> = {}): ThrobberActivityInput {
  return { turnActive: true, compacting: false, modelPhrase: 'Thinking...', turnStartMs: NOW - 12_000, now: NOW, ...overrides };
}

/** The throbber state a frame would draw for this moment, or null at rest. */
function throbberFor(moment: Partial<ThrobberActivityInput>): ThrobberState | null {
  const activity = resolveThrobberActivity(input(moment));
  return activity ? { spinner: '⠋', frame: 0, activity } : null;
}

describe('throbber: what it names', () => {
  test('nothing at rest: no turn and no compaction means no throbber', () => {
    expect(resolveThrobberActivity(input({ turnActive: false }))).toBeNull();
  });

  test('the model: the honest waiting phrase with the turn elapsed, first token and speed', () => {
    const activity = resolveThrobberActivity(input({ ttftMs: 800, tokenSpeed: 41.6 }))!;
    expect(throbberText({ activity })).toBe('Thinking... · 12s · first token 0.8s · 42 tok/s');
  });

  test('completion checking and reconnecting name Jev instead of showing a stalled model', () => {
    for (const phase of ['checking', 'waiting'] as const) {
      const activity = resolveThrobberActivity(input({ completionActivity: { phase, startedAtMs: NOW - 3_000 }, modelPhrase: 'Stalled 4069s...', ttftMs: 3_000, tokenSpeed: 76 }))!;
      const rendered = throbberText({ activity });
      expect(rendered).toBe(phase === 'checking' ? 'Jev is checking completion... · 3s' : 'Jev is recovering verification... · 3s');
      expect(rendered).not.toMatch(/Stalled|tok\/s|first token/);
      expect(resolveThrobberActivity(input({ turnActive: false, completionActivity: { phase, startedAtMs: NOW } }))).toBeNull();
    }
  });

  test('agent work stays visible after main yields and disappears when the last agent finishes', () => {
    for (const count of [6, 1, 0]) {
      const activity = throbberFor({
        turnActive: false, runningAgentCount: count,
        activeTool: { name: 'agent', args: { mode: 'batch-spawn' } },
        modelPhrase: 'Stalled 60s', ttftMs: 800, tokenSpeed: 42,
      });
      const rows = footer({ throbber: activity, runningAgentCount: count, turnRunning: false }).map(text);
      if (count === 0) {
        expect(activity).toBeNull();
        expect(rows.some(row => row.startsWith('   ⠋ '))).toBe(false);
      } else {
        expect(rows[1]).toContain(`⠋ Waiting for ${count} ${count === 1 ? 'agent' : 'agents'}...`);
        expect(rows[1]).not.toMatch(/Running|Stalled|tok\/s|first token/);
        expect(rows.join('\n')).not.toContain('interrupt');
      }
    }
    const resumed = throbberFor({ turnActive: true, runningAgentCount: 1 });
    expect(throbberText(resumed!)).toBe('Thinking... · 12s');
  });

  test('a running tool: its name, its key argument and its own elapsed time', () => {
    const activity = resolveThrobberActivity(input({ activeTool: { name: 'exec', args: { command: 'bun test src/net/retry.test.ts' }, startedAtMs: NOW - 3_000 } }))!;
    expect(throbberText({ activity })).toBe('Running exec · bun test src/net/retry.test.ts · 3s');
  });

  test('contract activity stays above the input before workers start and between workers', () => {
    const stages = [
      ['queued', 'Waiting to start...'],
      ['shaping', 'Shaping the request...'],
      ['planning', 'Planning the work...'],
      ['checking-plan', 'Checking the plan...'],
      ['running', 'Executing the plan...'],
      ['judging', 'Checking results...'],
      ['fixing', 'Revising the work...'],
      ['committing', 'Saving results...'],
      ['awaiting-owner', 'Waiting for your reply...'],
      ['passed', null], ['failed', null], ['cancelled', null],
    ] as const;
    for (const [status, phrase] of stages) {
      const contracts = [contractFixture({ status, units: [], groups: [] })];
      const summary = summarizeRunningAgents([{ id: 'owner', contractRole: 'owner' }], [{ id: 'owner' }], contracts);
      expect(summary.count).toBe(0);
      const throbber = throbberFor({ turnActive: false, runningAgentCount: summary.count, contracts,
        activeTool: { name: 'contract' }, modelPhrase: 'Stalled 60s', ttftMs: 800, tokenSpeed: 42 });
      const rows = footer({ throbber, turnRunning: false }).map(text);
      if (phrase === null) {
        expect(throbber).toBeNull();
        expect(rows.some(row => row.startsWith('   ⠋ '))).toBe(false);
      } else {
        expect(rows[1]).toContain(`⠋ ${phrase}`);
        expect(rows[1]).not.toMatch(/Stalled|tok\/s|first token|12s/);
      }
    }
  });

  test('contract stages take over worker waiting; main activity and compaction retain priority', () => {
    const contracts = [{ status: 'passed' }, { status: 'awaiting-owner' }, { status: 'queued' }, { status: 'planning' }] as const;
    expect(throbberText(throbberFor({ turnActive: false, runningAgentCount: 1, contracts })!)).toBe('Planning the work...');
    expect(throbberText(throbberFor({ contracts })!)).toBe('Thinking... · 12s');
    expect(throbberFor({ contracts, activeTool: { name: 'read' } })?.activity.kind).toBe('tool');
    expect(throbberFor({ contracts, pendingApproval: { name: 'write' } })?.activity.kind).toBe('approval');
    expect(throbberFor({ turnActive: false, compacting: true, contracts })?.activity.kind).toBe('compacting');
  });

  test('a pending publication retains the spinner and names recovery without changing footer height', () => {
    const saving = throbberFor({ turnActive: false, contracts: [contractFixture({ status: 'committing' })] });
    const recovering = throbberFor({ turnActive: false, contracts: [contractFixture({ status: 'committing',
      commit: { status: 'failed', note: 'Owner Git operation pending; accepted work retained.' } })] });
    const before = footer({ throbber: saving, turnRunning: false }).map(text);
    const after = footer({ throbber: recovering, turnRunning: false }).map(text);
    expect(after).toHaveLength(before.length);
    expect(after[1]).toContain('⠋ Recovering publication...');
    expect(after[1]).not.toContain('Thinking');
  });

  test('an MCP tool is named by its last segment, like its bead', () => {
    const activity = resolveThrobberActivity(input({ activeTool: { name: 'mcp__github__search_issues', args: { query: 'retry backoff' }, startedAtMs: NOW - 1_000 } }))!;
    expect(throbberText({ activity })).toBe('Running search_issues · retry backoff · 1s');
  });

  test('a long argument is cut so the elapsed time keeps its place', () => {
    const activity = resolveThrobberActivity(input({ activeTool: { name: 'read', args: { path: `src/${'deep/'.repeat(30)}file.ts` }, startedAtMs: NOW - 2_000 } }))!;
    expect(activity.kind).toBe('tool');
    if (activity.kind === 'tool') expect(activity.argument.length).toBeLessThanOrEqual(60);
    expect(throbberText({ activity }).endsWith('· 2s')).toBe(true);
  });

  test('a permission prompt waiting on you comes first, naming the call it holds', () => {
    const activity = resolveThrobberActivity(input({
      pendingApproval: { name: 'exec', args: { command: 'rm -rf dist' } },
      activeTool: { name: 'exec', args: { command: 'rm -rf dist' }, startedAtMs: NOW - 3_000 },
    }))!;
    expect(throbberText({ activity })).toBe('Waiting for your approval · exec · rm -rf dist · 12s');
  });

  test('a compaction is named, inside a turn or on its own', () => {
    expect(throbberText({ activity: resolveThrobberActivity(input({ compacting: true, compactingSinceMs: NOW - 4_000 }))! })).toBe('Compacting the conversation · 4s');
    expect(throbberText({ activity: resolveThrobberActivity(input({ turnActive: false, compacting: true, compactingSinceMs: NOW - 4_000 }))! })).toBe('Compacting the conversation · 4s');
  });

  test('inside a view it is led by "main", so it is never read as the view\'s own work', () => {
    const activity = resolveThrobberActivity(input())!;
    expect(throbberText({ activity, owner: 'main' })).toBe('main · Thinking... · 12s');
  });
});

describe('throbber: the row', () => {
  test('spinner in column 3, text from column 5, nothing past width-4', () => {
    for (const width of [40, 80, 120, 160]) {
      const line = renderThrobberLine(width, { spinner: '⠋', frame: 0, activity: { kind: 'tool', tool: 'exec', argument: 'x'.repeat(200), elapsedMs: 3_000 } });
      expect(line).toHaveLength(width);
      expect(line[3]!.char).toBe('⠋');
      expect(line[4]!.char).toBe(' ');
      expect(text(line).slice(5, 12)).toBe('Running');
      expect(line.slice(width - 3).every((c) => c.char === ' ')).toBe(true);
      expect(line.every((c) => c.bg === '')).toBe(true);
    }
  });

  test('on a short row the elapsed time goes before the argument is cut, and the label stays whole', () => {
    const line = text(renderThrobberLine(48, { spinner: '⠋', frame: 0, activity: { kind: 'tool', tool: 'exec', argument: 'bun test src/net/retry.test.ts --watch', elapsedMs: 3_000 } }));
    expect(line).toContain('Running exec · bun test');
    expect(line).toContain('…');
    expect(line).not.toContain('3s');
  });
});

describe('throbber: it follows the activity and is gone at rest', () => {
  test('rest → thinking → tool → approval → thinking → rest, one frame each', () => {
    const moments: Array<{ moment: Partial<ThrobberActivityInput>; want: string | null }> = [
      { moment: { turnActive: false }, want: null },
      { moment: {}, want: 'Thinking...' },
      { moment: { activeTool: { name: 'exec', args: { command: 'bun test' }, startedAtMs: NOW - 1_000 } }, want: 'Running exec · bun test · 1s' },
      { moment: { pendingApproval: { name: 'write', args: { path: 'src/net/retry.ts' } } }, want: 'Waiting for your approval · write · src/net/retry.ts' },
      { moment: {}, want: 'Thinking...' },
      { moment: { turnActive: false }, want: null },
    ];
    for (const { moment, want } of moments) {
      const lines = footer({ throbber: throbberFor(moment), turnRunning: moment.turnActive !== false });
      const rows = lines.map(text);
      const throbberRow = rows.findIndex((r) => r.startsWith('   ⠋ '));
      if (want === null) {
        expect(throbberRow).toBe(-1);
        expect(lines).toHaveLength(6); // input area 5 + status line 1
        expect(rows.join('\n')).not.toMatch(/Thinking|Running|Waiting/);
      } else {
        expect(throbberRow).toBe(1); // under the blank row
        expect(rows[throbberRow]).toContain(want);
        expect(lines).toHaveLength(8); // blank + throbber + input area 5 + status line 1
      }
    }
  });

  test('the status line keeps session state: no spinner or phrase on it, the esc hint while a turn runs', () => {
    const working = footer({ throbber: throbberFor({}), turnRunning: true });
    const status = text(working[working.length - 1]!);
    expect(status).not.toContain('Thinking');
    expect(status).not.toContain('⠋');
    expect(status).toContain('esc  interrupt');
    expect(status).toContain('context');
    expect(status).toContain('normal');
    const resting = footer();
    expect(text(resting[resting.length - 1]!)).not.toContain('interrupt');
  });

  test('the input area holds only input while main works', () => {
    const working = footer({ throbber: throbberFor({ activeTool: { name: 'exec', args: { command: 'bun test' } } }), turnRunning: true });
    const inputRows = working.slice(2, 7).map(text).join('\n');
    expect(inputRows).not.toMatch(/Running|Thinking|interrupt|esc/);
    expect(inputRows).toContain('Ask anything');
  });
});

describe('the stack under the transcript', () => {
  test('at rest: ▄ cap, padding, text, padding, ▀ cap, status line', () => {
    const lines = footer();
    const rows = lines.map(text);
    expect(rows[0]!.slice(2, 4)).toBe('╻▄');
    expect(rows[0]!.slice(3, 118)).toBe('▄'.repeat(115));
    expect(rows[1]![2]).toBe('┃');
    expect(rows[2]).toContain('Ask anything');
    expect(rows[3]![2]).toBe('┃');
    expect(rows[4]!.slice(2, 4)).toBe('╹▀');
    expect(rows[5]).toContain('ctrl+p');
    // The caps are the fill color on the terminal background: half a row of fill, half a row of gap.
    const t = activeTokens();
    expect(lines[0]!.slice(3, 118).every((c) => c.fg === t.backgroundElement && c.bg === '')).toBe(true);
    expect(lines[4]!.slice(3, 118).every((c) => c.fg === t.backgroundElement && c.bg === '')).toBe(true);
  });

  test('a view\'s body ends with its own blank row, so the footer adds none above the throbber', () => {
    const lines = buildShellFooter({
      width: 120, promptText: '', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
      runningAgentCount: 1, runningProcessCount: 0, indicatorFocused: false,
      view: { barColor: '#ff0000', keys: [['esc', 'back to main']] },
      throbber: throbberFor({}),
    }).lines;
    expect(text(lines[0]!)).toContain('main · Thinking...');
    expect(lines).toHaveLength(7);
  });

  test('toasts stay above the throbber and the input area', () => {
    const width = 120;
    const height = 30;
    const lines = footer({ throbber: throbberFor({}), turnRunning: true });
    const toast = { title: 'A long notice', body: 'word '.repeat(200), tone: 'info' as const };
    const layer = renderToasts(width, height, [toast, toast, toast], { top: 1, bottom: height - lines.length });
    expect(layer).not.toBeNull();
    expect(layer!.y + layer!.lines.length).toBeLessThanOrEqual(height - lines.length);
  });
});
