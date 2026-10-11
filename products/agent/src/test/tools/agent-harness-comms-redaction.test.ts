import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { saveDraft } from '../../agent/channel-draft.ts';
import { channelDraftsSummary, channelDraftSaveHandoff } from '../../tools/agent-harness-comms.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';

let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const answers = fakePort((name, question) => question.type === 'noul' ? noulAnswer(0.001)
    : choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : 'generic', 0.999));
  prior = installJudgmentPort(withDecisionLog(answers.port, log));
});
afterEach(() => { installJudgmentPort(prior); log[Symbol.dispose](); });

// A webhook URL can embed an authentication token in its path, so it must never
// be returned raw in any structured tool payload, only the formatted string is
// allowed to omit it and the structured `draft`/`drafts` must show [redacted].
const WEBHOOK = 'https://hooks.example.com/services/T000/B000/xoxb-super-secret-token';

function makeShellPaths(root: string) {
  return createShellPathService({ homeDirectory: root, workingDirectory: root });
}

function makeContext(shellPaths: ReturnType<typeof makeShellPaths>): CommandContext {
  return { workspace: { shellPaths } } as unknown as CommandContext;
}

describe('agent-harness-comms webhook redaction', () => {
  test('channel_drafts list never returns a raw webhook', async () => {
    const root = makeProjectTempDir('gv-comms');
    try {
      const shellPaths = makeShellPaths(root);
      await saveDraft(shellPaths, { message: 'hello', webhook: WEBHOOK });
      const result = await channelDraftsSummary(makeContext(shellPaths), {});
      const drafts = result.drafts as ReadonlyArray<{ readonly webhook?: string }>;
      expect(drafts.length).toBeGreaterThan(0);
      for (const draft of drafts) {
        if (draft.webhook !== undefined) expect(draft.webhook).toBe('[redacted]');
      }
      expect(JSON.stringify(result)).not.toContain(WEBHOOK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('channel_drafts single read redacts the webhook', async () => {
    const root = makeProjectTempDir('gv-comms');
    try {
      const shellPaths = makeShellPaths(root);
      const saved = await saveDraft(shellPaths, { message: 'hello', webhook: WEBHOOK });
      const result = await channelDraftsSummary(makeContext(shellPaths), { draftId: saved.draft.id });
      const draft = result.draft as { readonly webhook?: string };
      expect(draft.webhook).toBe('[redacted]');
      expect(JSON.stringify(result)).not.toContain(WEBHOOK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('channel_draft_save echoes a redacted webhook', async () => {
    const root = makeProjectTempDir('gv-comms');
    try {
      const shellPaths = makeShellPaths(root);
      const context = makeContext(shellPaths);
      const tool: Tool = { definition: { name: 'draft-redaction-fixture', description: 'Isolated synthetic draft display.', parameters: {} },
        async execute(args, options) { const result = await channelDraftSaveHandoff(context, args, options); return { success: typeof result !== 'string', output: JSON.stringify(result) }; } };
      const value = await recordedEffectFixture(tool, 'prompt', {}, root).run({
        draftMessage: 'hello',
        draftWebhook: WEBHOOK,
      });
      expect(value.success).toBe(true);
      const result = JSON.parse(value.output!);
      expect(typeof result).not.toBe('string');
      const draft = (result as Record<string, unknown>).draft as { readonly webhook?: string };
      expect(draft.webhook).toBe('[redacted]');
      expect(JSON.stringify(result)).not.toContain(WEBHOOK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
