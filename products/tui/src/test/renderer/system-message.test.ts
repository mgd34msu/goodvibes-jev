import { describe, expect, test } from 'bun:test';
import { renderSystemMessage } from '../../renderer/system-message.ts';
import { activeUiTones } from '../../renderer/theme.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';

const plain = (lines: ReturnType<typeof renderSystemMessage>) => lines.map(line => line.map(cell => cell.char).join('').trimEnd()).join('\n');

describe('system notice rendering', () => {
  test('unclassified prose paints neutrally and never starts a reading during repaint', () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'critical', 0.99));
    const previous = installJudgmentPort(fixture.port);
    try {
      for (const content of ['Build failed', '[Plan] error occurred', 'Alles ist fehlgeschlagen', 'Task: "Fix failed tests"']) {
        for (let frame = 0; frame < 3; frame++) {
          const lines = renderSystemMessage(content, 80);
          expect(plain(lines)).toContain(content);
          const marker = lines.flat().find(cell => cell.char === '▌');
          expect(marker?.fg).toBe(activeUiTones().chrome.faint);
        }
      }
      expect(fixture.requests).toHaveLength(0);
    } finally { installJudgmentPort(previous); }
  });

  for (const kind of ['error', 'warning', 'info'] as const) {
    test(`an explicitly supplied ${kind} severity controls the paint`, () => {
      const content = 'Operation completed successfully';
      const lines = renderSystemMessage(content, 80, kind);
      const tones = activeUiTones();
      const marker = lines.flat().find(cell => cell.char === '▌');
      expect(marker?.fg).toBe(kind === 'error' ? tones.chrome.bad : kind === 'warning' ? tones.chrome.warn : tones.state.info);
      expect(plain(lines)).toContain(content);
    });
  }
});
