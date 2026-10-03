import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { AgentWorkspace } from './agent-workspace.ts';

/** Lines per PageUp/PageDown in the action-result block. */
const RESULT_SCROLL_STEP = 5;

export function handleAgentWorkspaceToken(
  workspace: AgentWorkspace,
  token: InputToken,
  handleEscape: () => void,
  requestRender: () => void,
): boolean {
  if (!workspace.active) return false;

  if (workspace.localEditor) {
    if (token.type === 'text') {
      workspace.appendEditorText(token.value);
    } else if (token.type === 'key') {
      if (token.logicalName === 'escape') workspace.cancelLocalEditor();
      else if (token.logicalName === 'enter') workspace.submitEditorFieldOrForm(requestRender);
      else if (token.logicalName === 'tab' || token.logicalName === 'down') workspace.moveEditorField(1);
      else if (token.logicalName === 'up') workspace.moveEditorField(-1);
      else if (token.logicalName === 'backspace' || token.logicalName === 'delete') workspace.editorBackspace();
      else if (token.logicalName === 'j' && token.ctrl === true) workspace.appendEditorNewline();
    }
    requestRender();
    return true;
  }

  if (token.type === 'key') {
    if (workspace.actionSearchActive) {
      if (token.logicalName === 'escape') workspace.clearActionSearch();
      else if (token.logicalName === 'enter') workspace.activateSelected(requestRender);
      else if (token.logicalName === 'up') workspace.moveUp();
      else if (token.logicalName === 'down') workspace.moveDown();
      else if (token.logicalName === 'home') workspace.jumpHome();
      else if (token.logicalName === 'end') workspace.jumpEnd();
      else if (token.logicalName === 'backspace' || token.logicalName === 'delete') workspace.actionSearchBackspace();
      else if (token.logicalName === 'space') workspace.appendActionSearchText(' ');
      requestRender();
      return true;
    }
    if (token.logicalName === 'escape') {
      handleEscape();
      return true;
    }
    // A long action result scrolls rather than being cut off. These keys reach
    // the workspace already, they were consumed and did nothing, so binding
    // them here takes nothing away from the transcript scroll behind the modal.
    if (token.logicalName === 'pageup') workspace.scrollActionResult(-RESULT_SCROLL_STEP);
    else if (token.logicalName === 'pagedown') workspace.scrollActionResult(RESULT_SCROLL_STEP);
    else if (token.ctrl === true && token.logicalName === ']') workspace.cycleCategory('next');
    else if (token.ctrl === true && token.logicalName === '[') workspace.cycleCategory('prev');
    else if (token.logicalName === 'enter' || token.logicalName === 'space') workspace.activateSelected(requestRender);
    else if (token.logicalName === 'left') workspace.focusCategories();
    else if (token.logicalName === 'right') workspace.focusActions();
    else if (token.logicalName === 'up') workspace.moveUp();
    else if (token.logicalName === 'down') workspace.moveDown();
    else if (token.logicalName === 'tab') workspace.toggleFocusPane();
    else if (token.logicalName === 'home') workspace.jumpHome();
    else if (token.logicalName === 'end') workspace.jumpEnd();
  } else if (token.type === 'text') {
    if (workspace.actionSearchActive) workspace.appendActionSearchText(token.value);
    else if (token.value === '/') workspace.beginActionSearch();
    else if (token.value === 'h') workspace.focusCategories();
    else if (token.value === 'l') workspace.focusActions();
    else if (token.value === 'j') workspace.moveDown();
    else if (token.value === 'k') workspace.moveUp();
    else if (token.value === 'r' || token.value === 'R') workspace.refreshRuntimeSnapshot();
    else if (token.value === ' ') workspace.activateSelected(requestRender);
  }

  requestRender();
  return true;
}
