/**
 * The shell footer: the composer (5 rows at rest: a ▄ cap, padding, text,
 * padding, a ▀ cap; input only), the throbber while main works, and the
 * one-row status line, checked against the design's Measurements table, plus the
 * mode chip and the safety chips at the status line's left end that must stay
 * visible whatever else happens.
 */
import { describe, test, expect } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { buildShellFooter, estimateShellFooterHeight, type ShellFooterBuildOptions } from '../../renderer/shell-surface.ts';
import type { VoiceCaptureIndicatorState } from '../../core/voice-capture-status.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

function text(line: Line | undefined): string {
  return (line ?? []).map((cell) => cell.char).join('');
}

function footer(overrides: Partial<ShellFooterBuildOptions> = {}): ReturnType<typeof buildShellFooter> {
  return buildShellFooter({
    width: 120,
    promptText: '',
    promptLineCount: 1,
    usage: { up: 0, down: 0 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/tmp/demo',
    contextWindow: 200_000,
    compactThreshold: 80,
    lastInputTokens: 50_000,
    hitlMode: 'balanced',
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    composerMode: 'prompt',
    ...overrides,
  });
}

function allText(lines: Line[]): string {
  return lines.map(text).join('\n');
}

const STATUS = 5;

describe('shell footer: layout', () => {
  test('at rest it is 6 rows (composer 5, status line 1), and the estimate agrees', () => {
    const result = footer();
    expect(result.height).toBe(6);
    expect(estimateShellFooterHeight(1)).toBe(6);
    const three = footer({ promptText: 'a\nb\nc', promptLineCount: 3 });
    expect(three.height).toBe(estimateShellFooterHeight(3));
    expect(three.height).toBe(8);
  });

  test('half-row caps above and below the fill, with the bar\'s matching halves', () => {
    const t = activeTokens();
    const lines = footer().lines;
    const top = lines[0]!;
    const bottom = lines[4]!;
    expect(top[2]!.char).toBe('╻');
    expect(bottom[2]!.char).toBe('╹');
    for (let x = 3; x <= 117; x++) {
      expect(top[x]).toMatchObject({ char: '▄', fg: t.backgroundElement, bg: '' });
      expect(bottom[x]).toMatchObject({ char: '▀', fg: t.backgroundElement, bg: '' });
    }
  });

  test('while main works: one empty row, the throbber, then the composer; the status line keeps session state', () => {
    const lines = footer({ turnRunning: true, throbber: { spinner: '⠋', frame: 0, activity: { kind: 'tool', tool: 'Running a command', argument: 'bun test', elapsedMs: 3_000 } } }).lines;
    expect(lines).toHaveLength(8);
    expect(text(lines[0]).trim()).toBe('');
    expect(text(lines[1])).toContain('⠋ Running a command · bun test · 3s');
    expect(text(lines[2]).slice(2, 4)).toBe('╻▄');
    const status = text(lines[7]);
    expect(status).not.toContain('Running');
    expect(status).toMatch(/esc +interrupt/);
  });

  test('the composer bar runs every row at column 2 in the mode color, the fill spans 3..width-3, text starts at column 5', () => {
    const lines = footer({ promptText: 'hello there', promptCursorPos: 11 }).lines;
    const composer = lines.slice(1, 4);
    for (const row of composer) {
      expect(row[2]!.char).toBe('┃');
      expect(row[2]!.fg).toBe(activeTokens().brand);
      expect(row[3]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[117]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[118]!.bg).toBe('');
    }
    expect(text(composer[1]).indexOf('hello there')).toBe(5);
    // A padding row above the text and one below it.
    for (const index of [0, 2]) expect(text(composer[index]).trim()).toBe('┃');
  });

  test('the composer holds only input: no mode, model, provider or warning inside it', () => {
    const lines = footer({ promptText: 'hello', composerMode: 'plan', dangerMode: true, powerNote: 'sleep disabled', composerFlags: ['attachments'] }).lines;
    const composer = lines.slice(0, 5).map(text).join('\n');
    expect(composer).toContain('hello');
    for (const word of ['plan', 'balanced', 'claude-opus-4', 'anthropic', 'auto-approve', 'sleep disabled', 'image attached']) expect(composer).not.toContain(word);
  });

  test('the bar keeps the mode color: shell accent, command and plan info, delegation remote', () => {
    const t = activeTokens();
    expect(footer({ composerMode: 'shell' }).lines[1]![2]!.fg).toBe(t.accent);
    expect(footer({ composerMode: 'command' }).lines[1]![2]!.fg).toBe(t.info);
    expect(footer({ composerMode: 'plan' }).lines[2]![2]!.fg).toBe(t.info);
    expect(footer({ composerMode: 'prompt' }).lines[3]![2]!.fg).toBe(t.brand);
    expect(footer({ composerMode: 'prompt' }).lines[0]![2]!.fg).toBe(t.brand);
  });

  test('an empty composer shows the placeholder', () => {
    expect(text(footer().lines[2])).toContain('Ask anything, or type / for commands and @ for files');
  });

  test('an unfocused empty composer keeps its normal placeholder: the input area is input only', () => {
    const result = footer({ promptText: '', indicatorFocused: true });
    expect(text(result.lines[2])).toContain('Ask anything');
    expect(text(result.lines[2])).not.toContain('Esc returns');
    expect(text(result.lines[2])).not.toContain('█');
  });

  test('tree mode: the input area keeps its placeholder and the status line leads with esc back to typing at every width', () => {
    for (const width of [60, 80, 120, 160]) {
      const result = footer({ promptText: '', promptFocused: false, workTreeFocused: true, width, turnRunning: true });
      const status = text(result.lines[result.lines.length - 1]);
      expect(text(result.lines[2])).toContain('Ask anything');
      expect(status).toContain('esc  back to typing');
      // Esc leads; the other keys give way first.
      if (status.includes('↑↓')) expect(status.indexOf('esc')).toBeLessThan(status.indexOf('↑↓'));
    }
  });

  test('scrolled back: the pill shows over the input area and a running turn\'s esc says back to bottom; at the bottom neither', () => {
    const scrolled = footer({ promptText: '', turnRunning: true, backToBottom: { escKey: true } });
    const rows = scrolled.lines.map(text);
    const pill = rows.findIndex((r) => r.includes('↓ Back to bottom'));
    expect(pill).toBeGreaterThan(0);
    expect(rows[pill]).toContain('↓ Back to bottom   esc');
    expect(rows[pill + 1]).toContain('▄'); // right over the input area's cap
    expect(rows[pill - 1]!.trim()).toBe(''); // one empty row keeps it off the text above
    expect(rows[rows.length - 1]).toContain('back to bottom');
    expect(rows[rows.length - 1]).not.toContain('interrupt');
    const bottom = footer({ promptText: '', turnRunning: true, backToBottom: null }).lines.map(text);
    expect(bottom.some((r) => r.includes('Back to bottom'))).toBe(false);
    expect(bottom[bottom.length - 1]).toContain('interrupt');
  });

  test('scrolled back with text in the composer: the pill drops its esc keycap and the next Esc clears the input', () => {
    const rows = footer({ promptText: 'draft', turnRunning: true, backToBottom: { escKey: false } }).lines.map(text);
    const pill = rows.find((r) => r.includes('↓ Back to bottom'));
    expect(pill).toBeDefined();
    expect(pill).not.toContain('esc');
    expect(rows[rows.length - 1]).toContain('clear input');
  });

  test('multi-line input grows the composer and nothing else moves', () => {
    const lines = footer({ promptText: 'one\ntwo', promptLineCount: 2 }).lines;
    expect(lines).toHaveLength(7);
    expect(text(lines[2]).indexOf('one')).toBe(5);
    expect(text(lines[3]).indexOf('two')).toBe(5);
    expect(text(lines[4]).trim()).toBe('┃');
  });

  test('no row is wider than the screen, even narrow with a long model and every chip', () => {
    const lines = footer({
      width: 50,
      model: 'a-really-long-provider-model-identifier-that-wraps',
      dangerMode: true,
      powerNote: 'sleep disabled',
      voiceCapture: { kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' },
    }).lines;
    for (const line of lines) {
      expect(line.length).toBe(50);
      expect(getDisplayWidth(text(line))).toBeLessThanOrEqual(50);
    }
  });
});

describe('shell footer: the status line', () => {
  test('at rest: the mode chip, the directory, the cost, the context bar and the ctrl+p keycap', () => {
    const status = text(footer({ usage: { up: 10_000, down: 1_000 } }).lines[STATUS]);
    expect(status.slice(3)).toMatch(/^balanced {3}\/tmp\/demo/);
    expect(status).toContain('context');
    expect(status).toContain('25%');
    expect(status).toContain('ctrl+p');
    expect(status).toContain('menu');
  });

  test('right-aligned text ends at width-4 or earlier', () => {
    const status = footer().lines[STATUS]!;
    for (let x = 117; x < 120; x++) expect(status[x]!.char).toBe(' ');
    expect(status[116]!.char).not.toBe(' ');
  });

  test('below 100 columns the directory goes first', () => {
    expect(text(footer({ width: 96 }).lines[STATUS])).not.toContain('/tmp/demo');
  });

  test('a running turn\'s esc interrupt keycap follows the mode chip; the spinner and phrase are the throbber\'s', () => {
    const lines = footer({ turnRunning: true, throbber: { spinner: '⠋', frame: 0, activity: { kind: 'model', phrase: 'Thinking', elapsedMs: 12_400 } } }).lines;
    const status = text(lines[lines.length - 1]);
    expect(status).toMatch(/balanced {3} ?esc +interrupt/);
    expect(status).not.toContain('Thinking');
    expect(text(lines[1])).toContain('⠋ Thinking · 12s');
  });

  test('past the warning level the bar turns amber and never disappears', () => {
    const status = footer({ width: 60, lastInputTokens: 150_000, turnRunning: true, runningAgentCount: 3, runningAgentProgress: 'a very long progress line that would fill the row' }).lines[STATUS]!;
    expect(text(status)).toContain('75%');
    const pct = text(status).indexOf('75%');
    expect(status[pct]!.fg).toBe(activeTokens().warning);
  });

  test('background work shows on the status line, and its focus hands the keys to it', () => {
    const idle = text(footer({ runningAgentCount: 1, runningProcessCount: 2 }).lines[STATUS]);
    expect(idle).toContain('1 agent running · 2 processes running');
    const focused = footer({ runningAgentCount: 1, indicatorFocused: true });
    expect(text(focused.lines[STATUS])).toContain('open');
    // The input area keeps its normal placeholder while the background summary owns the keys.
    expect(text(focused.lines[2])).toContain('Ask anything');
    expect(text(focused.lines[2])).not.toContain('Esc returns');
  });

  test('the exit guard and the copy receipt follow the safety chips, which stay', () => {
    const exiting = text(footer({ showExitNotice: true, dangerMode: true }).lines[STATUS]);
    expect(exiting).toMatch(/! auto-approve {3}Press Ctrl\+C again to exit/);
    const copied = text(footer({ lastCopyTime: Date.now(), powerNote: 'sleep disabled' }).lines[STATUS]);
    expect(copied).toMatch(/balanced {2}sleep disabled {3}Copied/);
  });
});

describe('shell footer: the mode chip and safety chips', () => {
  test('the mode chip opens the status line: muted, plan in the info color', () => {
    const t = activeTokens();
    const normal = footer().lines[STATUS]!;
    expect(text(normal).slice(3, 11)).toBe('balanced');
    expect(normal[3]!.fg).toBe(t.textMuted);
    const plan = footer({ composerMode: 'plan' }).lines[STATUS]!;
    expect(text(plan).slice(3, 7)).toBe('plan');
    expect(plan[3]!.fg).toBe(t.info);
  });

  test('the command, shell and delegation intents name the chip', () => {
    expect(text(footer({ composerMode: 'shell' }).lines[STATUS]).slice(3)).toMatch(/^shell /);
    expect(text(footer({ composerMode: 'command' }).lines[STATUS]).slice(3)).toMatch(/^command /);
    expect(text(footer({ composerMode: 'delegation' }).lines[STATUS]).slice(3)).toMatch(/^delegation /);
  });

  test('auto-approve takes the mode chip in the error color', () => {
    const row = footer({ dangerMode: true }).lines[STATUS]!;
    expect(text(row).slice(3)).toMatch(/^! auto-approve/);
    expect(row[3]!.fg).toBe(activeTokens().error);
    expect(text(row)).not.toContain('balanced');
  });

  test('plan keeps its name beside the auto-approve warning', () => {
    expect(text(footer({ composerMode: 'plan', dangerMode: true }).lines[STATUS])).toContain('plan  ! auto-approve');
  });

  test('auto-approve and the power note render together; neither suppresses the other', () => {
    const row = text(footer({ dangerMode: true, powerNote: 'sleep disabled' }).lines[STATUS]);
    expect(row).toContain('! auto-approve  sleep disabled');
  });

  test.each([50, 60, 80, 120])('the mode chip, auto-approve and the power note survive %i columns', (width) => {
    const row = text(footer({ width, composerMode: 'plan', dangerMode: true, powerNote: 'held: backup running', lastInputTokens: 150_000, usage: { up: 1_000_000, down: 1_000_000 } }).lines[STATUS]);
    expect(row).toContain('plan');
    expect(row).toContain('! auto-approve');
    expect(row).toContain('held: backup running');
  });

  test('the attachment flag rides after the safety chips and is the first to go on a short row', () => {
    expect(text(footer({ composerFlags: ['attachments'] }).lines[STATUS])).toContain('balanced  image attached');
    const narrow = text(footer({ width: 50, dangerMode: true, powerNote: 'sleep disabled', composerFlags: ['attachments'] }).lines[STATUS]);
    expect(narrow).toContain('sleep disabled');
    expect(narrow).not.toContain('image attached');
  });

  test('each chip alone', () => {
    expect(allText(footer({ dangerMode: true }).lines)).toContain('! auto-approve');
    expect(allText(footer({ powerNote: 'sleep disabled' }).lines)).toContain('sleep disabled');
    expect(allText(footer().lines)).not.toContain('auto-approve');
  });
});

describe('shell footer: the live microphone', () => {
  const listening: VoiceCaptureIndicatorState = { kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' };

  test('a listening detector is a chip on the status line, costing no extra row', () => {
    const live = footer({ voiceCapture: listening });
    expect(live.height).toBe(6);
    const row = text(live.lines[STATUS]);
    // The chip sits right after the mode chip, 2 columns apart (its marker, a space, the words).
    expect(row.indexOf('mic listening')).toBe(3 + 'balanced'.length + 2 + 2);
  });

  test('voice.wake.indicator "off" shows nothing', () => {
    expect(allText(footer({ voiceCapture: { ...listening, indicator: 'off' } }).lines)).not.toContain('mic');
  });

  test('voice.wake.indicator "banner" draws the chip filled', () => {
    const row = footer({ voiceCapture: { ...listening, indicator: 'banner' } }).lines[STATUS]!;
    const at = text(row).indexOf('mic listening');
    expect(row[at]!.bg).not.toBe('');
    const plain = footer({ voiceCapture: listening }).lines[STATUS]!;
    expect(plain[text(plain).indexOf('mic listening')]!.bg).toBe('');
  });

  test('a detector that cannot hear says so', () => {
    expect(text(footer({ voiceCapture: { ...listening, kind: 'wake-no-microphone' } }).lines[STATUS])).toContain('no microphone');
  });
});
