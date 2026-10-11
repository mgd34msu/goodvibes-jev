import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { readNoticeSeverity } from '@goodvibes-jev/engine/terminal-shell';
import { ConversationManager } from '../../core/conversation.ts';
import { publishNotice } from '../../core/notices.ts';
import { createShellNoticeSink } from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'critical', 0.99)).port); });
afterEach(() => { installJudgmentPort(previous); });

function delayedReader() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = fakePort((_name, question) => choiceAnswer(question, 'critical', 0.99));
  const actions: string[] = [];
  const port: JudgmentPort = { ...fixture.port, recorder: {
    recordReadings() {}, recordAction(_id: string, action: string) { actions.push(action); },
  }, async ask(request) {
    entered.resolve();
    await release.promise;
    return { ...await fixture.port.ask(request), decisionId: 'notice-fixture' };
  } };
  installJudgmentPort(port);
  return { entered: entered.promise, release: () => release.resolve(), fixture, actions, port };
}

describe('canonical notice severity ingestion', () => {
  test('the reading controls publication, including a failure under an informational tag', async () => {
    const reader = delayedReader();
    const feed = new NotificationFeed();
    const pending = publishNotice(feed, '[Plan] Could not parse the plan\nExecution stopped.', { now: () => 5 });
    await reader.entered;
    expect(feed.list()).toHaveLength(0);
    expect(reader.actions).toEqual([]);
    reader.release();
    await pending;
    expect(feed.list()).toMatchObject([{ level: 'critical', title: '[Plan] Could not parse the plan', body: 'Execution stopped.', timestamp: 5 }]);
    expect(reader.actions).toEqual(['notice-published:critical']);
    expect(reader.fixture.requests[0]?.state).toEqual({ text: '[Plan] Could not parse the plan\nExecution stopped.' });
  });

  for (const retire of ['reset', 'restore', 'undo', 'rewind', 'branch', 'sink disposal', 'feed clear'] as const) {
    test(`${retire} cancels an uncooperative reader before history or toast publication`, async () => {
      const reader = delayedReader();
      const feed = new NotificationFeed();
      const conversation = new ConversationManager();
      conversation.setNoticeSink(createShellNoticeSink(feed));
      if (retire === 'branch') conversation.forkBranch('saved');
      conversation.addUserMessage('begin');
      conversation.addSystemMessage('A notice whose reading is still pending');
      await reader.entered;
      if (retire === 'reset') conversation.resetAll();
      if (retire === 'restore') conversation.fromJSON({ messages: [] });
      if (retire === 'undo') expect(conversation.undo()).toBe(true);
      if (retire === 'rewind') conversation.removeMessagesAfter(0);
      if (retire === 'branch') expect(conversation.switchBranch('saved')).toBe(true);
      if (retire === 'sink disposal') conversation.setNoticeSink(null);
      if (retire === 'feed clear') feed.clear();
      await conversation.whenNoticesSettled();
      expect(feed.list()).toHaveLength(0);
      expect(reader.actions).toEqual([]);
      reader.release();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(feed.list()).toHaveLength(0);
      expect(reader.actions).toEqual([]);
    });
  }

  test('source retirement interrupts a reader which ignores its signal', async () => {
    const reader = delayedReader();
    const source = new AbortController();
    bindJudgmentPortAuthority(reader.port, () => ({ identity: source, signal: source.signal, assertCurrent() {} }));
    const pending = readNoticeSeverity('An operation failed');
    await reader.entered;
    source.abort();
    await expect(pending).rejects.toThrow('The judgment reading owner is no longer current.');
    expect(reader.actions).toEqual([]);
    reader.release();
  });

  test('a notice still belongs to its history when streaming removes only its assistant placeholder', async () => {
    const reader = delayedReader();
    const feed = new NotificationFeed();
    const conversation = new ConversationManager();
    conversation.setNoticeSink(createShellNoticeSink(feed));
    conversation.startStreamingBlock();
    conversation.addSystemMessage('The provider reported a problem during streaming');
    await reader.entered;
    conversation.finalizeStreamingBlock();
    reader.release();
    await conversation.whenNoticesSettled();
    expect(feed.list()).toMatchObject([{ title: 'The provider reported a problem during streaming', level: 'critical' }]);
  });

  test('port replacement cannot publish or log a retired observation', async () => {
    const reader = delayedReader();
    const feed = new NotificationFeed();
    const pending = publishNotice(feed, 'A reading from the old source');
    await reader.entered;
    installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'info', 0.99)).port);
    await expect(Promise.resolve(pending)).rejects.toThrow('The judgment reading owner is no longer current.');
    reader.release();
    expect(feed.list()).toHaveLength(0);
    expect(reader.actions).toEqual([]);
  });

  for (const confidence of [0.5, 0.99]) {
    test(`uncertain or unknown prose is held without an invented severity (${confidence})`, async () => {
      installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, confidence === 0.99 ? 'unknown' : 'critical', confidence)).port);
      const feed = new NotificationFeed();
      await publishNotice(feed, 'arbitrary prose');
      expect(feed.list()).toHaveLength(0);
    });
  }

  test('unavailable reading preserves the saved message and produces no guessed notice', async () => {
    installJudgmentPort(undefined);
    const conversation = new ConversationManager();
    const feed = new NotificationFeed();
    conversation.setNoticeSink(createShellNoticeSink(feed));
    conversation.addSystemMessage('Something failed');
    await conversation.whenNoticesSettled();
    expect(conversation.getMessageSnapshot()).toMatchObject([{ content: 'Something failed' }]);
    expect(feed.list()).toHaveLength(0);
  });

  test('complete private input is screened before model access or retention, including a late credential', async () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'critical', 0.99));
    installJudgmentPort(fixture.port);
    const feed = new NotificationFeed();
    await expect(Promise.resolve(publishNotice(feed, 'x'.repeat(20_000) + '\napi_key=PRIVATE_NOTICE_SECRET'))).rejects.toThrow('Refused before judgment');
    expect(fixture.requests).toHaveLength(0);
    expect(feed.list()).toHaveLength(0);
  });

  test('typed runtime facts publish synchronously without a semantic request', () => {
    const fixture = fakePort(() => { throw new Error('Typed facts must not invoke judgment'); });
    installJudgmentPort(fixture.port);
    const feed = new NotificationFeed();
    const result = publishNotice(feed, '[Agents] ✗ engineer worker: "Fix failed tests" — failed in 1s: diagnostic', {
      runtimeEvent: { type: 'AGENT_FAILED', occurrenceId: 'typed-occurrence' }, now: () => 1,
    });
    expect(result).toBeUndefined();
    expect(feed.list()).toMatchObject([{ title: 'Agent failed', level: 'warning' }]);
    expect(fixture.requests).toHaveLength(0);
  });
});
