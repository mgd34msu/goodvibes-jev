/**
 * The Google connection cards.
 *
 * The defect these guard against is the one that produced the whole round: a
 * capability that exists in code but that a person cannot reach. `/google` fixed
 * it for people who type commands; these cards fix it for people who click. So
 * the load-bearing test here is the parity one, every route the command
 * exposes has a card, because that is the assertion that fails if someone adds
 * a seventh subcommand and stops there.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { createAgentWorkspaceEditor } from '../../input/agent-workspace-activation.ts';
import { trySubmitDirectHostActionEditor } from '../../input/agent-workspace-direct-editor-submission.ts';
import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');

function findAction(id: string) {
  for (const category of AGENT_WORKSPACE_CATEGORIES) {
    const action = category.actions.find((entry) => entry.id === id);
    if (action) return action;
  }
  return undefined;
}

/** Card id -> the `/google` route it is the UI equivalent of. */
const GOOGLE_CARDS = [
  ['personal-ops-google-connect', 'google-connect', 'connect'],
  ['personal-ops-google-status', 'google-status', 'status'],
  ['personal-ops-google-reauthorize', 'google-reauthorize', 'reauthorize'],
  ['personal-ops-google-forget', 'google-forget', 'forget'],
  ['personal-ops-google-app-password', 'google-setup-app-password', 'setup --path app-password'],
  ['personal-ops-google-oauth', 'google-setup-walkthrough', 'setup --path oauth'],
  ['personal-ops-google-adopt', 'google-adopt', 'adopt'],
  ['personal-ops-google-client-file', 'google-client-file', 'client-file'],
  ['personal-ops-google-client-manual', 'google-client-manual', 'client'],
] as const;

/** Cards whose run reaches Google's sign-in wall and therefore stops for a person. */
const BROWSER_CARDS: readonly AgentWorkspaceEditorKind[] = [
  'google-setup-app-password',
  'google-setup-walkthrough',
  'google-client-file',
  'google-client-manual',
];

describe('the Google connection cards', () => {
  test('every route is a real, dispatchable editor card', () => {
    for (const [id, editorKind] of GOOGLE_CARDS) {
      const action = findAction(id);
      expect(action, `missing card ${id}`).toBeDefined();
      expect(action?.kind).toBe('editor');
      expect(action?.editorKind).toBe(editorKind);
      expect(createAgentWorkspaceEditor(editorKind)).not.toBeNull();
    }
  });

  test('the UI covers every intake route the command exposes', () => {
    // Read the command's own declared subcommands rather than a copy of them, so
    // adding a route to /google without adding a card fails here.
    const runtime = readFileSync(join(repoRoot, 'src/input/commands/google-runtime.ts'), 'utf8');
    const argsHint = /argsHint: '([^']+)'/.exec(runtime)?.[1] ?? '';
    const subcommands = argsHint.split('|').map((entry) => entry.trim()).filter(Boolean);
    expect(subcommands.length).toBeGreaterThan(0);

    // `account`, `calendar-address` and `runbook` are inputs to a route rather
    // than routes themselves; the six connection routes are the ones a person
    // picks between, and each has a card.
    //
    // `approve` is excluded for a different and stronger reason: it must NOT
    // have a card. It grants authority over one refused outward action, and a
    // workspace card is dispatchable by the model through `workspace
    // action:"run"`. Giving it a card would hand the model the button that
    // clears the boundary, which is the exact route content that was just read
    // would take, the same hole the `invokedByModel` check closes on the
    // slash-command path. It is typed by the owner or it does not happen.
    const covered = new Set(['account', 'calendar-address', 'runbook', 'approve']);
    for (const [, , route] of GOOGLE_CARDS) covered.add(route.split(' ')[0] as string);

    for (const sub of subcommands) {
      expect(covered.has(sub), `/google ${sub} has no workspace card`).toBe(true);
    }
  });

  test('the approval route has no workspace card, and must not gain one', () => {
    // The inverse of the rule above, asserted rather than left as a comment.
    // `/google approve` clears an outward-effect refusal, and every workspace
    // card is dispatchable by the model via `workspace action:"run"`. A card
    // here would let a message the agent had just read talk the model into
    // pressing the button that authorizes the send that message wanted, with
    // no keystroke from the owner anywhere in the chain.
    //
    // If a future change adds an approval card, this fails, and that is the
    // intent: the gesture has to stay something only a human at the keyboard
    // can perform.
    const approvalCards = AGENT_WORKSPACE_CATEGORIES
      .flatMap((category) => category.actions)
      .filter((action) => /google.*approv|approv.*google/i.test(action.id))
      .map((action) => action.id);
    expect(approvalCards).toEqual([]);
  });

  test('every card that opens a browser says the flow pauses for a hand sign-in', () => {
    for (const kind of BROWSER_CARDS) {
      const editor = createAgentWorkspaceEditor(kind);
      const message = (editor?.message ?? '').toLowerCase();
      expect(message, `${kind} does not warn about the pause`).toContain('pause');
      expect(message).toContain('sign in');
    }
  });

  test('the client secret field is redacted and the client id is not', () => {
    const editor = createAgentWorkspaceEditor('google-client-manual');
    const secret = editor?.fields.find((field) => field.id === 'clientSecret');
    const id = editor?.fields.find((field) => field.id === 'clientId');
    expect(secret?.redact).toBe(true);
    expect(id?.redact).not.toBe(true);
  });

  test('the status card is read-only and the flow cards are not', () => {
    expect(findAction('personal-ops-google-status')?.safety).toBe('read-only');
    for (const [id] of GOOGLE_CARDS.filter(([cardId]) => cardId !== 'personal-ops-google-status')) {
      expect(findAction(id)?.safety).toBe('safe');
    }
  });

  test('every Google editor submits as a direct host action, never as a command string', () => {
    // A slash command carrying a client secret would be echoed back into the
    // rendered result. Routing through the direct path is what keeps it out.
    for (const [, editorKind] of GOOGLE_CARDS) {
      const editor = createAgentWorkspaceEditor(editorKind) as AgentWorkspaceLocalEditor;
      const host = { localEditor: null, status: '', lastActionResult: null, runtimeSnapshot: null } as never;
      const handled = trySubmitDirectHostActionEditor(host, editor, null, () => 'yes');
      expect(handled, `${editorKind} fell through to command dispatch`).toBe(true);
    }
  });
});
