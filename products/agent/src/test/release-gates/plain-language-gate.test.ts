import { describe, expect, test } from 'bun:test';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES } from '../../input/agent-workspace-onboarding-categories.ts';
import { friendlyToolLabel } from '../../renderer/tool-labels.ts';
import { buildSetupIncompleteHint } from '../../core/setup-incomplete-hint.ts';
import { buildAwayDigest } from '../../core/away-digest.ts';
import { FIRST_GLANCE_BANNED, EVERYWHERE_BANNED, validate } from '../../core/plain-language.ts';
import { TOOL_LABELS_CATALOG } from '../../renderer/tool-labels.ts';

/**
 * Plain-language gate, the operator-facing copy must read like a person
 * wrote it for a person. Internal vocabulary (tool syntax, runtime jargon,
 * coding-agent terms) stays on model-facing surfaces, never in labels,
 * summaries, or hints the user reads first.
 *
 * Scope is deliberate: category LABELS and SUMMARIES plus action LABELS are
 * the first-glance copy. Action DETAILS may carry more technical depth, but
 * still must not leak raw runtime jargon (WRFC, modelRoute).
 *
 * The banned-term lists and validate helper live in src/core/plain-language.ts
 * so they can be reused by other tests without duplicating the definitions.
 */

function violations(text: string, rules: readonly RegExp[]): string[] {
  return validate(text, rules).map((rule) => String(rule));
}

// All categories across both workspace and onboarding files.
const ALL_CATEGORIES = [
  ...AGENT_WORKSPACE_CATEGORIES,
  ...AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES,
];

describe('plain-language gate', () => {
  // ── Workspace categories ────────────────────────────────────────────

  test('workspace category labels and summaries read like plain language', () => {
    const failures: string[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const hit of violations(`${category.label} ${category.summary}`, FIRST_GLANCE_BANNED)) {
        failures.push(`${category.id}: label/summary matches ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('workspace action labels read like plain language', () => {
    const failures: string[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const action of category.actions) {
        for (const hit of violations(action.label, FIRST_GLANCE_BANNED)) {
          failures.push(`${category.id}/${action.id}: label matches ${hit}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('workspace action details never leak raw runtime jargon', () => {
    const failures: string[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const action of category.actions) {
        for (const hit of violations(action.detail, EVERYWHERE_BANNED)) {
          failures.push(`${category.id}/${action.id}: detail matches ${hit}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('onboarding category details do not leak runtime jargon', () => {
    const failures: string[] = [];
    for (const category of ALL_CATEGORIES) {
      for (const hit of violations(category.detail, EVERYWHERE_BANNED)) {
        failures.push(`${category.id}: category detail matches ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('home lane details carry no tool syntax at all', () => {
    const home = AGENT_WORKSPACE_CATEGORIES.find((category) => category.id === 'home');
    expect(home).toBeDefined();
    const failures: string[] = [];
    for (const action of home!.actions) {
      for (const hit of violations(`${action.label} ${action.detail}`, FIRST_GLANCE_BANNED)) {
        failures.push(`home/${action.id}: matches ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // ── away-digest static strings ───────────────────────────────────────

  test('away-digest output strings contain no first-glance jargon', () => {
    const digest = buildAwayDigest({
      lastSeenAt: Date.now() - 3_600_000,
      schedules: [{ name: 'Morning summary', lastRunAt: Date.now() - 1_800_000, runCount: 1 }],
      tasks: [{ title: 'Research task', status: 'done', completedAt: Date.now() - 900_000 }],
      pendingApprovals: 2,
      deliveries: [{ label: 'Weekly digest' }],
    });
    expect(digest).not.toBeNull();
    const allText = [digest!.headline, ...digest!.lines].join(' ');
    const failures = violations(allText, FIRST_GLANCE_BANNED);
    expect(failures).toEqual([]);
  });

  // ── setup-incomplete-hint strings ─────────────────────────────────

  test('setup-incomplete-hint strings contain no first-glance jargon', () => {
    const cases = [
      { phase: 'in-progress' as const, readyToChat: false, steps: [], blockers: [] },
      { phase: 'in-progress' as const, readyToChat: true, steps: [], blockers: [] },
      {
        phase: 'in-progress' as const,
        readyToChat: true,
        steps: [{ id: 'model', label: 'Choose a model', status: 'pending' as const, nextLabel: undefined }],
        blockers: [],
      },
    ];
    const failures: string[] = [];
    for (const state of cases) {
      for (const hostReady of [true, false, null, undefined] as const) {
        const result = buildSetupIncompleteHint(state as unknown as Parameters<typeof buildSetupIncompleteHint>[0], hostReady);
        if (result) {
          const text = result.lines.join(' ');
          for (const hit of violations(text, FIRST_GLANCE_BANNED)) {
            failures.push(`setup-incomplete-hint (readyToChat=${state.readyToChat}, hostReady=${String(hostReady)}): matches ${hit}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // ── friendly tool labels ─────────────────────────────────────────────
  //
  // Enumerate all curated tool IDs from TOOL_LABELS_CATALOG plus a set of
  // first-class tool names used in production. The strengthened assertion checks:
  //   - no underscore characters (raw_identifier smell)
  //   - starts with a capital letter
  //   - length > 3 (not a meaningless stub)
  //   - not in a denylist of still-jargon words

  const LABEL_JARGON_DENYLIST = [
    /\bharness\b/i,
    /\bdaemon\b/i,
  ];

  // The canonical tool-id catalog comes from the keys of TOOL_LABELS in tool-labels.ts.
  // These are the IDs that friendlyToolLabel() maps to human phrases.
  const ALL_TOOL_IDS = [
    ...Object.keys(TOOL_LABELS_CATALOG),
    // Also cover the original 7 sample IDs from the prior test to avoid regression.
    'web_search', 'exec', 'personal_ops', 'agent_channel_send', 'agent_harness',
    'memory', 'research',
  ].filter((id, i, arr) => arr.indexOf(id) === i); // deduplicate

  test('friendly tool labels are human phrases, not identifiers: full catalog', () => {
    const failures: string[] = [];
    for (const id of ALL_TOOL_IDS) {
      const label = friendlyToolLabel(id);

      if (label.includes('_')) {
        failures.push(`${id}: label contains underscore: "${label}"`);
      }
      if (label.length <= 3) {
        failures.push(`${id}: label too short: "${label}"`);
      }
      if (!/^[A-Z]/u.test(label)) {
        failures.push(`${id}: label does not start with a capital letter: "${label}"`);
      }
      for (const jargon of LABEL_JARGON_DENYLIST) {
        if (jargon.test(label)) {
          failures.push(`${id}: label matches jargon denylist ${String(jargon)}: "${label}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('friendlyToolLabel fallback (uncurated id) produces a human-readable auto-label', () => {
    // 'some_new_uncurated_tool' is deliberately NOT in TOOL_LABELS_CATALOG.
    // This exercises the humanize() fallback path so a future engineer adding
    // a new tool without registering a curated label still gets a sane auto-label.
    const syntheticId = 'some_new_uncurated_tool';
    expect(Object.keys(TOOL_LABELS_CATALOG)).not.toContain(syntheticId);

    const label = friendlyToolLabel(syntheticId);

    // Must convert underscores to spaces, no raw identifier smell.
    expect(label).not.toContain('_');
    // Must produce a phrase with meaningful content (not an empty stub).
    expect(label.length).toBeGreaterThan(3);
    // Must start with a capital letter (humanize() capitalizes the first character).
    expect(label).toMatch(/^[A-Z]/u);
    // Must not leak jargon through the auto-label path.
    for (const jargon of LABEL_JARGON_DENYLIST) {
      expect(jargon.test(label)).toBe(false);
    }
    // Must not echo the raw id verbatim.
    expect(label).not.toBe(syntheticId);
  });
});
