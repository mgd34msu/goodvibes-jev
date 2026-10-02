/**
 * The forget path, exercised against the REAL owner-profile store and the real
 * `profile.*` handlers, not a stub that agrees with whatever this surface
 * happens to send.
 *
 * Every other suite in this lane injects a fake gateway, which is right for
 * asserting what the tool DOES with an answer but cannot catch the class that
 * bit this round twice: the daemon's input contract changing underneath a body
 * this surface still builds the old way. `authority` becoming required and
 * `forget` losing `lineIndex` both compiled clean and passed every stubbed test.
 *
 * So this file builds a genuine store over a temp file, attaches the platform's
 * own handlers to a catalog, and drives the tool's real invoker through them.
 * A wrong body gets the daemon's own 400 here.
 *
 * ## Nothing here touches his profile
 *
 * The store's path comes from `profile.path`, which `resolveOwnerProfilePath`
 * honours ahead of `--daemon-home`, `GOODVIBES_DAEMON_HOME` and the default
 * `~/.goodvibes/daemon/`. Every test points it at a temp file it created and
 * deletes afterwards. The daemon-scope file is never opened.
 *
 * ── Whose composition this drives ────────────────────────────────────────
 *
 * `buildDaemonGatewayCatalog(services)` builds the catalog THE DAEMON composes
 * over this graph, the agent's own `services.gatewayMethods` carries no handler
 * for any of these any more, and that absence is itself pinned in
 * daemon/gateway-ws-only-invokable.test.ts.
 *
 * The behaviour below did not move or change; its OWNER did. These verbs are
 * served to every surface by one process now, and this suite is where the
 * contract that surface depends on stays honest. Driving it through the
 * daemon's composition is the difference between verifying a contract and
 * asserting that a client answers its own question.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { buildDaemonGatewayCatalog } from '../helpers/daemon-gateway.ts';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createAgentProfileTool } from '../../tools/agent-profile-tool.ts';
import { createProfileGatewayInvoke } from '../../agent/owner-profile-gateway.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';

const PROFILE_FIXTURE = `# Mike's profile

## Identity

goes by: Mike

## Notes

- Allergic to shellfish — agent, 2026-07-27, "I'm allergic to shellfish"
- Prefers aisle seats — agent, 2026-07-27, "I like an aisle seat"
`;

const roots: string[] = [];

interface LiveProfile {
  readonly tool: Tool;
  readonly profilePath: string;
  readonly read: () => string;
  readonly rewrite: (text: string) => void;
  /** Block until the store's watcher has picked up an external edit. */
  readonly awaitReload: (marker: string) => Promise<void>;
}

/** Polls `predicate` on a bounded deadline. Never an unbounded wait in a test. */
async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function liveProfile(): Promise<LiveProfile> {
  const root = makeProjectTempDir('gv-agent-profile-live');
  roots.push(root);
  const workingDir = join(root, 'workspace');
  const profilePath = join(root, 'daemon', 'owner-profile.md');
  writeFileSync(join(root, '.keep'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, PROFILE_FIXTURE, 'utf-8');

  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-agent'),
  });
  // The one thing that keeps this off his real file. resolveOwnerProfilePath
  // takes this ahead of the daemon home and the default location.
  configManager.set('profile.path', profilePath);

  const services = await createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    workingDir,
    homeDirectory: root,
    getConversationTitle: () => 'profile-live',
  });

  const tool = createAgentProfileTool({
    invoke: createProfileGatewayInvoke({
      gatewayMethods: buildDaemonGatewayCatalog(services),
      configManager,
      homeDirectory: root,
    }),
  });

  // This wait is belt-and-braces now, and it returns on the first poll.
  //
  // It was load-bearing once. The composition used to start the file read and
  // return without awaiting it, so for the first few milliseconds every verb
  // answered "has not been loaded yet", a fourth state, where §4.4 allows
  // exactly three (loaded, disabled, unavailable-with-a-reason). Four of these
  // tests passed against THAT before this wait existed: they expected a refusal
  // and got a not-loaded, which is not the gate they were written to prove.
  // Below the verbs it was worse, because nothing logged it, the consumer
  // fallback was attached but resolved nothing, so a consumer key read as unset
  // rather than as its profile value.
  //
  // The platform closed it, and not with the readiness promise once expected
  // here: `registerGatewayVerbGroups` is synchronous, so an awaited load would
  // have rippled through the whole composition root. The store grew `loadSync()`
  // instead, and routes/owner-profile-composition.ts calls it before returning,
  // by then the state is one of the three, always. That is in the SDK this
  // package pins, and it is the composition this suite drives.
  //
  // The wait stays because a test that depends on timing should say so rather
  // than rely on the fix holding.
  await waitFor('the profile to load', async () => {
    const status = await tool.execute({ action: 'status' });
    return (status.output ?? '').includes('Profile: loaded');
  });

  return {
    tool,
    profilePath,
    read: () => readFileSync(profilePath, 'utf-8'),
    rewrite: (text: string) => { writeFileSync(profilePath, text, 'utf-8'); },
    // §5.3: a hand edit is picked up without a restart. Waiting on the store's
    // own view rather than a sleep also proves that watcher actually works.
    awaitReload: (marker: string) => waitFor(`the store to re-read "${marker}"`, async () => {
      const read = await tool.execute({ action: 'read' });
      return (read.output ?? '').includes(marker);
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('forget, against the real store', () => {
  test('a prose line named by its content is the line that goes', async () => {
    const profile = await liveProfile();

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Allergic to shellfish',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    const after = profile.read();
    expect(after).not.toContain('Allergic to shellfish');
    // Everything else survives byte-for-byte, including his other note.
    expect(after).toContain('Prefers aisle seats');
    expect(after).toContain('goes by: Mike');
  });

  test('his concurrent edit does not make the delete hit the wrong line', async () => {
    const profile = await liveProfile();

    // He opens the file and adds a line above the one about to be forgotten.
    // Under the old positional contract, the index a read produced now names a
    // different line. This is the real hazard, against the real writer.
    profile.rewrite(profile.read().replace(
      '- Allergic to shellfish',
      '- Renewed passport in March\n- Allergic to shellfish',
    ));
    await profile.awaitReload('Renewed passport in March');

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Allergic to shellfish',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    const after = profile.read();
    expect(after).not.toContain('Allergic to shellfish');
    // The line he had just added is untouched, a positional delete would have
    // taken this one and reported success.
    expect(after).toContain('Renewed passport in March');
    expect(after).toContain('Prefers aisle seats');
  });

  test('a line whose text no longer matches deletes nothing, and the file is unchanged', async () => {
    const profile = await liveProfile();
    // He reworded it since the read.
    profile.rewrite(profile.read().replace('Allergic to shellfish', 'Allergic to shellfish and peanuts'));
    await profile.awaitReload('and peanuts');
    const before = profile.read();

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Allergic to shellfish',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain('never report this as done');
    expect(profile.read()).toBe(before);
  });

  test('two lines reading exactly the same are refused rather than guessed between', async () => {
    const profile = await liveProfile();
    profile.rewrite(profile.read().replace(
      '- Prefers aisle seats — agent, 2026-07-27, "I like an aisle seat"',
      '- Prefers aisle seats\n- Prefers aisle seats',
    ));
    await profile.awaitReload('Prefers aisle seats');
    const before = profile.read();

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Prefers aisle seats',
      authority: 'owner-direct',
    });

    // Content addressing can be ambiguous where a position never is. The store
    // answers that plainly instead of removing whichever it saw first, and the
    // file is untouched, the right trade, since deleting the wrong one of two
    // identical lines is unrecoverable and asking is not.
    expect(result.success).toBe(false);
    expect(result.output).toContain('read exactly that');
    expect(profile.read()).toBe(before);
  });

  test('the whole line is what matches: a partial or reworded line finds nothing', async () => {
    const profile = await liveProfile();
    const before = profile.read();

    // 'Allergic to shellfish', the same line without its list marker, is
    // deliberately NOT in this list. It is due to become a match; see the
    // list-marker pin below.
    for (const text of ['allergic to shellfish', '- Allergic to shellfish and peanuts']) {
      const result = await profile.tool.execute({
        action: 'forget',
        section: 'Notes',
        text,
        authority: 'owner-direct',
      });
      expect(result.success, `"${text}" should not have matched`).toBe(false);
      expect(profile.read(), `"${text}" changed the file`).toBe(before);
    }
  });

  test('a list marker is not part of the line: his own wording names it', async () => {
    // He says "forget that I'm allergic to shellfish". The leading "- " is a
    // markdown artefact of how the line is stored, not something he uttered, so
    // requiring it would push a storage detail into the model's prompt, and a
    // prompt that carries a format rots silently when the format moves.
    //
    // This was a self-converting pin while the matcher still compared raw text:
    // it asserted the exact build known not to normalise, so the first repack
    // past it would fail rather than sit green on a tolerance. That build has
    // landed, the pin took its assertion branch, and the tolerance is gone.
    const profile = await liveProfile();

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: 'Allergic to shellfish',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    const after = profile.read();
    expect(after).not.toContain('Allergic to shellfish');
    expect(after).toContain('Prefers aisle seats');
  });

  test('the stored form still names the same line', async () => {
    const profile = await liveProfile();

    const result = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Allergic to shellfish',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    expect(profile.read()).not.toContain('Allergic to shellfish');
  });

  test('a leading minus that is not a list marker is kept', async () => {
    // The boundary the normalisation has to get right. A marker is only a
    // marker when whitespace follows it, so a line that genuinely begins with
    // a negative number keeps its minus and is matched on its real text. Get
    // this wrong and "-5 degrees" and "5 degrees" become the same line.
    const profile = await liveProfile();
    profile.rewrite(profile.read().replace(
      '- Prefers aisle seats',
      '- Prefers aisle seats\n-5 degrees is when the pipes freeze',
    ));
    await profile.awaitReload('pipes freeze');

    const wrong = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '5 degrees is when the pipes freeze',
      authority: 'owner-direct',
    });
    expect(wrong.success, 'the minus was stripped as if it were a list marker').toBe(false);
    expect(profile.read()).toContain('-5 degrees is when the pipes freeze');

    const right = await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '-5 degrees is when the pipes freeze',
      authority: 'owner-direct',
    });
    expect(right.success).toBe(true);
    expect(profile.read()).not.toContain('pipes freeze');
  });

  test('a mechanical field still goes by its id, and its history goes with it', async () => {
    const profile = await liveProfile();
    await profile.tool.execute({
      action: 'set',
      fieldId: 'location.timezone',
      value: 'America/Detroit',
      said: 'I am on Detroit time',
      authority: 'owner-direct',
    });
    expect(profile.read()).toContain('America/Detroit');

    const result = await profile.tool.execute({
      action: 'forget',
      fieldId: 'location.timezone',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    const after = profile.read();
    expect(after).not.toContain('America/Detroit');
    expect(after).not.toContain('<!-- was:');
  });

  test('an untrusted authority is refused by the real gate, and the file is byte-identical', async () => {
    const profile = await liveProfile();
    const before = profile.read();

    for (const authority of ['web-page', 'email', 'channel-message', 'document'] as const) {
      const result = await profile.tool.execute({
        action: 'forget',
        section: 'Notes',
        text: '- Allergic to shellfish',
        authority,
      });
      expect(result.success, `${authority} was not refused`).toBe(false);
      expect(profile.read(), `${authority} changed the file`).toBe(before);
    }
  });

  test('a write records his verbatim words, and the disclosure comes back to say so', async () => {
    const profile = await liveProfile();

    const result = await profile.tool.execute({
      action: 'append',
      section: 'Notes',
      text: 'Runs a half marathon in October',
      said: 'I am running a half marathon in October',
      authority: 'owner-direct',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Say this in your reply:');
    const after = profile.read();
    expect(after).toContain('Runs a half marathon in October');
    // Provenance round-trips through the file: surface, date, his own words.
    expect(after).toContain('agent');
    expect(after).toContain('"I am running a half marathon in October"');
  });

  test('nothing outside the temp file is touched', async () => {
    const profile = await liveProfile();
    await profile.tool.execute({
      action: 'forget',
      section: 'Notes',
      text: '- Prefers aisle seats',
      authority: 'owner-direct',
    });

    // The store writes through a temp-then-rename, so assert no stray temp file
    // was left beside the target either.
    const leftovers = readdirSync(dirname(profile.profilePath)).filter((name) => name !== 'owner-profile.md');
    expect(leftovers).toEqual([]);
  });
});
