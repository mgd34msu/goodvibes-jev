import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SessionViews } from '../../shell/session-views.ts';
import { makeProcessOutputReadingFixture } from '../helpers/process-output-reading.ts';

const views: SessionViews[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); });
function setup() {
  let record: NonNullable<ReturnType<ProcessManager['getStatus']>> | undefined = {
    id: 'owned-process', pid: 42, cmd: 'serve', startTime: 0, stdout: ['Server listening on port 3000\nBuild failed with 2 errors\n'], stderr: [], done: false, exitCode: null, killDeadline: null,
  };
  let renders = 0;
  const view = new SessionViews({
    conversation: { laneColorOf: () => 1, getWorkTreeSources: () => ({}), getTreeGlyphSet: () => 'rounded' },
    agentManager: { list: () => [], getStatus: () => null, getConversationSnapshot: () => [] },
    processManager: { list: () => record ? [{ id: record.id, pid: record.pid, cmd: record.cmd, done: record.done, status: 'running' }] : [], getStatus: () => record, stop: () => false },
    fleetNodes: () => [], steer: () => ({ queued: true, messageId: 'unused' }), killAgent: () => [], mainBusy: () => false, mainModel: () => '', promptText: () => '', requestRender: () => { renders++; }, pollMs: 0,
  });
  views.push(view); view.open({ kind: 'process', id: 'owned-process' }); view.poll();
  return { view, renders: () => renders, replaceArrays() { if (record) record.stdout = ['new output\n']; }, remove() { record = undefined; } };
}
const text = (lines: readonly import('@goodvibes-jev/engine/sdk/platform/types').Line[]) => lines.map(line => line.map(cell => cell.char).join('')).join('\n');

describe('process session reading lifecycle', () => {
  test('actual asynchronous observations repaint cached rows and the port header without paint requests', async () => {
    const fixture = makeProcessOutputReadingFixture(['Build failed with 2 errors'], ['Server listening on port 3000']);
    const previous = installJudgmentPort(fixture.port);
    try {
      const s = setup();
      const before = s.view.frame(100)!; const beforeRows = before.body(20);
      expect(text([before.header])).not.toContain(':3000');
      const beforeRenders = s.renders();
      await s.view.log.whenSettled();
      const after = s.view.frame(100)!; const afterRows = after.body(20);
      expect(text([after.header])).toContain(':3000');
      expect(afterRows).not.toEqual(beforeRows);
      expect(s.renders()).toBeGreaterThan(beforeRenders);
      const calls = fixture.requests.length;
      for (let i = 0; i < 5; i++) s.view.frame(100)?.body(20);
      await s.view.log.whenSettled(); expect(fixture.requests).toHaveLength(calls);
    } finally { installJudgmentPort(previous); }
  });
  for (const retire of ['replace arrays', 'remove', 'dispose'] as const) {
    test(`actual manager ${retire} prevents a late reading from publishing`, async () => {
      const fixture = makeProcessOutputReadingFixture(['Build failed with 2 errors'], ['Server listening on port 3000']);
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const port: JudgmentPort = { ...fixture.port, async ask(request) { entered.resolve(); await release.promise; return fixture.port.ask(request); } };
      const previous = installJudgmentPort(port);
      try {
        const s = setup(); const pending = s.view.log.whenSettled(); await entered.promise;
        if (retire === 'replace arrays') s.replaceArrays();
        if (retire === 'remove') s.remove();
        if (retire === 'dispose') s.view.dispose();
        release.resolve(); await pending;
        expect(s.view.log.port('owned-process')).toBeUndefined();
        expect(s.view.log.lines('owned-process').every(line => line.error === undefined)).toBe(true);
      } finally { installJudgmentPort(previous); }
    });
  }
  for (const retire of ['replace arrays', 'remove'] as const) {
    test(`actual manager ${retire} retires completed line colors without another poll`, async () => {
      const fixture = makeProcessOutputReadingFixture(['Build failed with 2 errors'], ['Server listening on port 3000']);
      const previous = installJudgmentPort(fixture.port);
      try {
        const s = setup(); await s.view.log.whenSettled();
        expect(s.view.log.lines('owned-process').some(line => line.error === true)).toBe(true);
        if (retire === 'replace arrays') s.replaceArrays(); else s.remove();
        expect(s.view.log.lines('owned-process').every(line => line.error === undefined)).toBe(true);
        expect(s.view.log.port('owned-process')).toBeUndefined();
      } finally { installJudgmentPort(previous); }
    });
  }
});
