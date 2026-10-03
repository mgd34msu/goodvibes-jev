import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  deleteDraft,
  formatChannelDraft,
  formatChannelDraftList,
  getDraft,
  listDrafts,
  markDraftFailed,
  markDraftSent,
  queueDraftToSend,
  readChannelDrafts,
  saveDraft,
} from '../../agent/channel-draft.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Test shell-path stub
// ---------------------------------------------------------------------------

function makeShellPaths(root: string) {
  return {
    resolveUserPath: (...parts: string[]) => join(root, ...parts),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channel-draft', () => {
  test('readChannelDrafts returns empty when file does not exist', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const snapshot = readChannelDrafts(makeShellPaths(root));
      expect(snapshot.exists).toBe(false);
      expect(snapshot.drafts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('saveDraft creates a new draft and persists it', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const result = await saveDraft(shellPaths, {
        message: 'Hello Slack',
        channel: 'slack:ops',
        title: 'Ops message',
      });
      expect(result.draft.id).toMatch(/^draft-/);
      expect(result.draft.message).toBe('Hello Slack');
      expect(result.draft.channel).toBe('slack:ops');
      expect(result.draft.title).toBe('Ops message');
      expect(result.draft.status).toBe('draft');
      expect(result.draft.version).toBe(1);

      const snapshot = readChannelDrafts(shellPaths);
      expect(snapshot.exists).toBe(true);
      expect(snapshot.drafts).toHaveLength(1);
      expect(snapshot.drafts[0]?.message).toBe('Hello Slack');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('saveDraft with existing id updates in-place', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const first = await saveDraft(shellPaths, { message: 'Original text', channel: 'slack:ops' });
      const draftId = first.draft.id;

      const updated = await saveDraft(shellPaths, { id: draftId, message: 'Updated text', channel: 'slack:ops' });
      expect(updated.draft.id).toBe(draftId);
      expect(updated.draft.message).toBe('Updated text');
      expect(updated.draft.createdAt).toBe(first.draft.createdAt);

      const snapshot = readChannelDrafts(shellPaths);
      expect(snapshot.drafts).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('saveDraft rejects empty message', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      await expect(saveDraft(makeShellPaths(root), { message: '  ' })).rejects.toThrow('Draft message is required.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getDraft returns draft by id, null when not found', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const result = await saveDraft(shellPaths, { message: 'Check this', route: 'my-route' });
      const found = getDraft(shellPaths, result.draft.id);
      expect(found).not.toBeNull();
      expect(found?.route).toBe('my-route');

      const notFound = getDraft(shellPaths, 'does-not-exist');
      expect(notFound).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deleteDraft removes the draft', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const result = await saveDraft(shellPaths, { message: 'To be deleted', channel: 'discord:general' });
      const draftId = result.draft.id;

      expect((await deleteDraft(shellPaths, draftId)).deleted).toBe(true);
      expect(getDraft(shellPaths, draftId)).toBeNull();
      expect((await deleteDraft(shellPaths, draftId)).deleted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listDrafts filters by status', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      await saveDraft(shellPaths, { message: 'Draft one', channel: 'slack:a', status: 'draft' });
      await saveDraft(shellPaths, { message: 'Queued one', channel: 'slack:b', status: 'queued' });
      await saveDraft(shellPaths, { message: 'Sent one', channel: 'slack:c', status: 'sent' });

      const drafts = listDrafts(shellPaths, { status: 'draft' });
      expect(drafts.drafts).toHaveLength(1);
      expect(drafts.drafts[0]?.message).toBe('Draft one');

      const all = listDrafts(shellPaths);
      expect(all.drafts).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listDrafts respects limit', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      for (let i = 0; i < 5; i++) {
        await saveDraft(shellPaths, { message: `Draft ${i}`, channel: 'slack:ops' });
      }
      const limited = listDrafts(shellPaths, { limit: 2 });
      expect(limited.drafts).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('queueDraftToSend promotes draft to queued and returns delivery input', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, {
        message: 'Ready to send',
        channel: 'slack:ops',
        title: 'Ops alert',
      });

      const queued = await queueDraftToSend(shellPaths, saved.draft.id);
      expect(queued.draftId).toBe(saved.draft.id);
      expect(queued.draft.status).toBe('queued');
      expect(queued.deliveryInput.message).toBe('Ready to send');
      expect(queued.deliveryInput.channel).toBe('slack:ops');
      expect(queued.deliveryInput.title).toBe('Ops alert');

      const persisted = getDraft(shellPaths, saved.draft.id);
      expect(persisted?.status).toBe('queued');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('queueDraftToSend throws when draft not found', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      await expect(queueDraftToSend(makeShellPaths(root), 'bad-id')).rejects.toThrow('Draft not found: bad-id');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('queueDraftToSend throws when draft already sent', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'Sent draft', channel: 'slack:ops', status: 'sent' });
      await expect(queueDraftToSend(shellPaths, saved.draft.id)).rejects.toThrow('already sent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('markDraftSent updates status and records response id', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'Send me', channel: 'slack:ops' });
      const sent = markDraftSent(shellPaths, saved.draft.id, 'response-abc');
      expect(sent.status).toBe('sent');
      expect(sent.sentResponseId).toBe('response-abc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('markDraftFailed updates status and records error', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'Will fail', channel: 'slack:ops' });
      const failed = markDraftFailed(shellPaths, saved.draft.id, 'Connection refused');
      expect(failed.status).toBe('failed');
      expect(failed.sendError).toBe('Connection refused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('formatChannelDraft produces human-readable output', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'Hello world', channel: 'telegram:-100', title: 'Greeting', tags: ['ops', 'alert'] });
      const output = formatChannelDraft(saved.draft);
      expect(output).toContain('draft-');
      expect(output).toContain('telegram:-100');
      expect(output).toContain('Greeting');
      expect(output).toContain('ops, alert');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('formatChannelDraftList shows summary', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      await saveDraft(shellPaths, { message: 'First draft', channel: 'slack:ops' });
      await saveDraft(shellPaths, { message: 'Second draft', route: 'my-route' });
      const snapshot = readChannelDrafts(shellPaths);
      const output = formatChannelDraftList(snapshot);
      expect(output).toContain('Channel Drafts');
      expect(output).toContain('total: 2');
      expect(output).toContain('First draft');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('draft tags are optional', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'No tags', channel: 'slack:ops' });
      expect(saved.draft.tags).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('webhook target is preserved in draft and delivery input', async () => {
    const root = makeProjectTempDir('gv-drafts');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'Webhook msg', webhook: 'https://example.test/hook' });
      const queued = await queueDraftToSend(shellPaths, saved.draft.id);
      expect(queued.deliveryInput.webhook).toBe('https://example.test/hook');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
