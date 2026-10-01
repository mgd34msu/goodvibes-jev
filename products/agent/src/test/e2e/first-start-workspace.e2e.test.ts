/**
 * First start in a workspace this home has never seen, on the built binary.
 *
 * The Agent asks once whether to register the workspace for automatic
 * (turn-end) checkpoints. The question is drawn on the screen, it takes no
 * keystroke the owner did not aim at it, and after it is answered the owner's
 * first typed prompt reaches the conversation whole: the model receives the
 * exact text and its reply is drawn. The answer is recorded against the
 * workspace, so a second launch there does not ask again.
 *
 * Before the fix the question went only to the activity feed, which the main
 * screen does not draw, while the shell held the next keystroke (or a whole
 * paste) as its answer: the prompt below lost its first chunk.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKSPACE_QUESTION,
  answerWorkspaceQuestion,
  inputAreaVisible,
  lastUserText,
  launchAgent,
  makeHome,
  removeHome,
  screenText,
  startStubModel,
  type AgentSession,
  type E2EHome,
} from './harness.ts';

const PROMPT = 'first words in a brand new workspace';
const REPLY = 'The new workspace answer is seven.';

const model = startStubModel((request) => (
  lastUserText(request).includes('brand new workspace') ? { text: REPLY } : { text: 'E2E side request' }
));
let agent: AgentSession | null = null;
let home: E2EHome | null = null;
afterAll(() => { agent?.stop(); model.stop(); removeHome(home); });

describe('first start in a new workspace', () => {
  test('the workspace question is drawn, and the first typed prompt reaches the conversation whole', async () => {
    home = await makeHome(model);
    agent = launchAgent(home, { cols: 100, rows: 30 });
    await agent.waitForScreen('the main screen', inputAreaVisible, 45_000);

    const asked = await answerWorkspaceQuestion(agent, 'decline');
    expect(screenText(asked)).toContain('Not here');

    agent.type(PROMPT);
    agent.key('Enter');
    const answered = await agent.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);

    // The model got the prompt exactly as typed: nothing was taken off its front.
    expect(model.requests.some((request) => lastUserText(request).trim() === PROMPT)).toBe(true);
    expect(screenText(answered)).toContain(PROMPT);
    expect(screenText(answered)).not.toContain(WORKSPACE_QUESTION);

    // The decline is recorded against this workspace.
    const register = join(home.home, '.goodvibes', 'shared', 'workspace-registrations.json');
    expect(existsSync(register)).toBe(true);
    const recorded = JSON.parse(readFileSync(register, 'utf8')) as { declines?: Array<{ root: string }> };
    expect((recorded.declines ?? []).map((entry) => entry.root)).toContain(realpathSync(home.workspace));
    expect(agent.alive()).toBe(true);
  }, 150_000);
});
