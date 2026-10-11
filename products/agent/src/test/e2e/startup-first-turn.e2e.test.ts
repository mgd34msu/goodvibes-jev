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
import { startE2ENativeHost } from './native-host-fixture.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
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
let host: Awaited<ReturnType<typeof startE2ENativeHost>> | null = null;
afterEach(async () => {
  await agent?.stop(); agent = null;
  try { await host?.stop(); } finally { host = null; removeHome(home); home = null; }
});
afterAll(() => model.stop());

describe('main screen and first turn', () => {
  test('startup draws the main screen, and a typed prompt is answered on it', async () => {
    home = await makeHome(model);
    host = await startE2ENativeHost(home);
    agent = launchAgent(home, { cols: 100, rows: 30, env: host.env });

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
    expect(home.judgments.accepted).toContain('native-route');
    expect(home.judgments.accepted).toContain('native-turn');
    expect(home.judgments.accepted).not.toContain('route');
    expect(home.judgments.accepted).not.toContain('turn');
    expect(host.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(host.daemon.services.agentManager.list()).toHaveLength(0);
    expect(agent.alive()).toBe(true);
  }, 120_000);
});


test('without a paired host, the first prompt gets a visible setup diagnostic and never reaches the model', async () => {
  home = await makeHome(model);
  agent = launchAgent(home, { cols: 100, rows: 30 });
  await agent.waitForScreen('the main screen', inputAreaVisible, 45_000);
  await answerWorkspaceQuestion(agent, 'decline');
  const before = model.requests.length;
  agent.type(PROMPT); agent.key('Enter');
  const refused = await agent.waitForScreen('the missing-host diagnostic', s => screenText(s).includes('Connected-host operator token is required.'), 10_000);
  expect(screenText(refused)).not.toContain(REPLY);
  expect(model.requests).toHaveLength(before);
  expect(home.judgments.accepted).not.toContain('native-route');
  expect(home.judgments.accepted).not.toContain('route');
  expect(existsSync(join(home.home, '.goodvibes/agent/native-work-submission.json.intake'))).toBe(false);
  expect(agent.alive()).toBe(true);
}, 120_000);
