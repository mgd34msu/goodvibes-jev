/**
 * The first-start "register this workspace?" question, asked as a selection
 * modal on the kit.
 *
 * It used to be a system message plus a shell-level wait for the next
 * keystroke. System messages route to the activity feed, which the main screen
 * does not draw, so the question was invisible while the wait took the owner's
 * next keystroke (or a whole paste) as its answer. A modal is drawn where the
 * owner is looking, and it only receives the keys aimed at it.
 *
 * Owner-approved design kept: registering is an explicit opt-in, the default is
 * no, and Escape declines; either answer is recorded against the root so the
 * question is asked once.
 */
import type { SelectionItem, SelectionResult } from '../input/selection-modal.ts';

export const WORKSPACE_REGISTRATION_QUESTION = 'Register this workspace for automatic checkpoints?';

/** Opens the question for `root`; `answer` is called once, true for register. */
export type AskWorkspaceRegistration = (root: string, answer: (accepted: boolean) => void) => void;

export interface SelectionOpener {
  openSelection(
    title: string,
    items: SelectionItem[],
    opts: { preSelectId?: string; allowSearch?: boolean } | undefined,
    callback: (result: SelectionResult | null) => void,
  ): void;
}

export function workspaceRegistrationItems(root: string): SelectionItem[] {
  return [
    { id: 'register', label: 'Register', detail: `turn-end checkpoints on in ${root}` },
    { id: 'decline', label: 'Not here', detail: "checkpoints stay off; won't ask again for this location" },
  ];
}

/** The question on the input handler's selection modal. Escape or closing it declines. */
export function createWorkspaceRegistrationQuestion(opener: SelectionOpener): AskWorkspaceRegistration {
  return (root, answer) => {
    opener.openSelection(WORKSPACE_REGISTRATION_QUESTION, workspaceRegistrationItems(root), { preSelectId: 'decline', allowSearch: false }, (result) => {
      answer(result?.item.id === 'register');
    });
  };
}
