/**
 * A transcript export must not become a copy of the owner's dossier.
 *
 * docs/owner-profile.md §10 and §11.3 keep closed-tier profile content, his
 * address, his contact details, the People section, out of exports. The
 * platform runtime supplies those values to `redactSensitiveData` through a
 * registered reader; this asserts that THIS surface's own `/session export`
 * (which builds its transcript text itself, rather than through the platform's
 * session-export module) actually passes its output through that function.
 *
 * No profile file is opened here: the reader is registered directly with the
 * values a loaded profile would supply, and cleared afterwards, so the test
 * touches nothing at daemon scope.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { registerProfileRedactionValues } from '@goodvibes-jev/engine/sdk/platform/utils';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const HOME_ADDRESS = '401 Home St, Lansing, MI 48933, US';
const SISTER_LINE = 'Sarah, sister, sarah@example.com';
/** Short enough to fall under the distinctiveness floor, so only `absolute` catches it. */
const SHORT_NAME = 'Bob Lee';

const tmpDirs: string[] = [];

function makeContext(printed: string[]): { ctx: CommandContext; sm: SessionManager } {
  const tmpDir = makeProjectTempDir('gv-session-export-profile-containment');
  tmpDirs.push(tmpDir);
  const sm = new SessionManager(tmpDir, { surfaceRoot: 'agent' });
  const ctx = {
    session: {
      runtime: { sessionId: 'containment-session', model: 'gpt-5.4', provider: 'openai' },
      conversationManager: {
        getMessageCount: () => 2,
        title: 'Ordering something',
        getMessageSnapshot: () => [],
        getTitleSource: () => 'user',
        resetAll: () => {},
        fromJSON: () => {},
        rebuildHistory: () => {},
      },
      sessionManager: sm,
      writeLastSessionPointer: () => {},
    },
    provider: {},
    workspace: {},
    platform: { configManager: { get: () => 'off' } },
    ops: {},
    extensions: {},
    clients: { providerApi: { selectModel: async () => { throw new Error('no model in test'); } } },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
  return { ctx, sm };
}

afterEach(() => {
  registerProfileRedactionValues(null);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session export containment for owner-profile values', () => {
  test('closed-tier values a turn used do not survive into an exported transcript', async () => {
    const printed: string[] = [];
    const { ctx, sm } = makeContext(printed);

    sm.save(
      'containment-session',
      [
        { role: 'user', content: 'order it' },
        { role: 'assistant', content: `Shipping to ${HOME_ADDRESS}, cc'ing ${SISTER_LINE}, and telling ${SHORT_NAME}.` },
      ],
      { title: 'Ordering something', model: 'gpt-5.4', provider: 'openai', timestamp: Date.now() },
    );

    // Two classes, and the split matters here: his address is an ordinary
    // closed-tier value subject to the distinctiveness floor, while a People
    // line is redacted regardless of length or shape because §10 is absolute.
    // A seven-character name like "Bob Lee" falls under the floor and would
    // otherwise survive into an export.
    registerProfileRedactionValues(() => ({
      guarded: [HOME_ADDRESS],
      absolute: [SISTER_LINE, SHORT_NAME],
    }));

    const handled = await handleSessionWorkflowCommand(['export', 'containment-session', 'markdown'], ctx);

    expect(handled).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain('# Session:');
    expect(output).not.toContain(HOME_ADDRESS);
    expect(output).not.toContain('sarah@example.com');
    // The short-name case: absolute, so the floor does not let it through.
    expect(output).not.toContain(SHORT_NAME);
  });

  test('with no profile loaded the export is unchanged', async () => {
    const printed: string[] = [];
    const { ctx, sm } = makeContext(printed);

    sm.save(
      'containment-session',
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Nothing sensitive here.' },
      ],
      { title: 'Ordinary session', model: 'gpt-5.4', provider: 'openai', timestamp: Date.now() },
    );

    const handled = await handleSessionWorkflowCommand(['export', 'containment-session', 'text'], ctx);

    expect(handled).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain('Nothing sensitive here.');
  });
});
