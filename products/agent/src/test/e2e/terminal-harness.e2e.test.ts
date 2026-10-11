/** The generic harness owns an actual compiled-binary PTY, not a transcript stub. */
import { expect, test } from 'bun:test';
import { answerWorkspaceQuestion, inputAreaVisible, launchAgent, makeHome, removeHome, startStubModel } from './harness.ts';

test('the owned compiled terminal resizes, keeps current screen separate from history, and awaits shutdown', async () => {
  const model = startStubModel(() => ({ text: 'UNEXPECTED MODEL REQUEST' }));
  const home = await makeHome(model);
  const agent = launchAgent(home, { cols: 100, rows: 30 });
  try {
    await answerWorkspaceQuestion(agent, 'decline');
    expect(agent.alive()).toBe(true);
    expect(agent.screen().split('\n')).toHaveLength(30);
    const beforeResize = agent.rawOutput().length;
    agent.resize(120, 36);
    await agent.waitForScreen('resized main screen', screen => agent.rawOutput().length > beforeResize
      && screen.includes('GoodVibes Agent') && inputAreaVisible(screen), 10_000);
    expect(agent.screen().split('\n')).toHaveLength(36);
    expect(agent.rawOutput()).toContain('\x1b[');

    const marker = 'owned unsent PTY echo';
    const beforeEcho = agent.rawOutput().length;
    agent.type(marker);
    await agent.waitForScreen('real input echo', screen => screen.includes(marker), 10_000);
    const echoedHistory = agent.rawOutput();
    expect(echoedHistory.length).toBeGreaterThan(beforeEcho);
    agent.key('C-u');
    await agent.waitForScreen('cleared current input', screen => inputAreaVisible(screen) && !screen.includes(marker), 10_000);
    expect(agent.rawOutput().startsWith(echoedHistory)).toBe(true);
    expect(agent.rawOutput().length).toBeGreaterThan(echoedHistory.length);
    expect(model.requests).toHaveLength(0);
    expect(agent.stderr()).not.toMatch(/Error|panic|Unhandled/);

    await agent.stop();
    expect(agent.alive()).toBe(false);
    await agent.stop();
    expect(agent.alive()).toBe(false);
  } finally {
    await agent.stop();
    model.stop();
    removeHome(home);
  }
}, 60_000);
