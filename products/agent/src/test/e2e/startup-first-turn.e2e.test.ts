/**
 * The built binary in a real terminal, on the production render path:
 *
 *   startup     a home whose owner already finished onboarding, with a
 *               scripted OpenAI-compatible model selected, draws the main
 *               screen: the header naming this build and the selected model,
 *               the splash, the input area, and the status line reading the
 *               model's own 64k context window from its provider file; nothing
 *               on stderr and no error on screen.
 *   first turn  a typed prompt reaches the model with that text, and the
 *               model's reply is drawn in the transcript.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  answerWorkspaceQuestion,
  binaryVersion,
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

const PROMPT = 'please answer the e2e marmot question';
const REPLY = 'The marmot answer is forty-two.';

const model = startStubModel((request) => (
  lastUserText(request).includes('marmot question') ? { text: REPLY } : { text: 'E2E side request' }
));
let agent: AgentSession | null = null;
let home: E2EHome | null = null;
afterAll(() => { agent?.stop(); model.stop(); removeHome(home); });

describe('main screen and first turn', () => {
  test('startup draws the main screen, and a typed prompt is answered on it', async () => {
    home = await makeHome(model);
    agent = launchAgent(home, { cols: 100, rows: 30 });

    await agent.waitForScreen('the main screen', (s) => inputAreaVisible(s) && /context/.test(s), 45_000);
    // A workspace this home has never seen: the first-start question comes first.
    const screen = await answerWorkspaceQuestion(agent, 'decline').then(() => agent!.screen());
    const lines = screen.split('\n');
    expect(lines[0]).toContain(`GoodVibes Agent v${binaryVersion()}`);
    expect(lines[0]).toContain('stub-model');
    expect(screenText(screen)).toContain('start chatting or type /help for commands');
    expect(screen).toMatch(/context\s.*\/ 64(?:\.0)?k/);
    expect(screen).not.toMatch(/\b(Error|error:|failed to start|Unhandled|TypeError|ReferenceError)\b/);
    expect(agent.stderr()).not.toMatch(/Error|panic|Unhandled/);

    agent.type(PROMPT);
    agent.key('Enter');

    const answered = await agent.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(answered)).toContain(PROMPT);
    expect(agent.alive()).toBe(true);
  }, 120_000);
});
