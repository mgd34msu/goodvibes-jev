/**
 * conversational-capture-contract.test.ts
 *
 * The Agent found the owner's flight itinerary in his mail, answered "plan to
 * be at the airport by 5:55 AM", and recorded nothing, the next session's
 * plans query answered "(none recorded)". In the same session it went into the
 * GoodVibes platform source under his projects directory and announced it was
 * "repairing that control flow" while he had asked it to sign in to an email
 * account.
 *
 * Both halves are pinned here: the capture contract the turn is given, and the
 * boundary it is held to. Modelled on the SDK's
 * test/personal-information-capture.test.ts, same fake-port shape, same
 * insistence that each reason the capture could not have happened gets its own
 * test so none of them come back quietly.
 */
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { CONVERSATIONAL_TURN_TOOLS } from '@goodvibes-jev/engine/sdk/platform/personal-capture';
import {
  AGENT_CONVERSATIONAL_CAPTURE_POLICY,
  AGENT_CONVERSATIONAL_CAPTURE_TOOLS,
  missingConversationalCaptureTools,
  resolveAgentTurnCaptureAuthority,
} from '../../runtime/agent-conversational-capture.ts';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from '../../runtime/agent-operator-policy.ts';
import {
  AGENT_PLATFORM_BOUNDARY_DENIAL,
  installAgentPlatformBoundaryGuard,
  isGoodVibesPlatformSourcePath,
  ownerAskedAboutPlatformSource,
  validatePlatformBoundaryForAgentPolicy,
} from '../../tools/agent-platform-boundary-policy.ts';
import { registerAgentOccasionsTool } from '../../tools/agent-occasions-tool.ts';
import { registerAgentProfileTool } from '../../tools/agent-profile-tool.ts';

/** The itinerary as the agent actually found it in his mail. */
const ITINERARY_DETAILS = [
  'confirmation B79YKY',
  'Southwest flight 995 DAL 07:55 to MSY 09:20 on Thu Aug 06',
  'return flight 3175 MSY 15:40 to DAL 17:10 on Sun Aug 09',
];

/** A stand-in tool that records the args it was called with and always succeeds. */
function stubTool(name: string): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    calls,
    definition: {
      name,
      description: `stub ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
    execute: async (args: unknown) => {
      calls.push(args);
      return { success: true, output: 'ok' };
    },
  };
  return tool as unknown as Tool & { calls: unknown[] };
}

// ── 1. The capture tools a conversational turn actually has ─────────────────

describe('a conversational turn can reach the capture tools', () => {
  test('the capture floor names the profile tool, from the SDK contract', () => {
    expect(CONVERSATIONAL_TURN_TOOLS).toContain('profile');
    expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain('profile');
  });

  test('it composes with the SDK list rather than replacing it', () => {
    // Every tool the SDK contract names is still required here. The Agent adds
    // `occasions`, its half of the capture surface, and takes nothing away.
    for (const name of CONVERSATIONAL_TURN_TOOLS) {
      expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain(name);
    }
    expect(AGENT_CONVERSATIONAL_CAPTURE_TOOLS).toContain('occasions');
  });

  test('a registry with this build\'s capture tools registered is missing nothing', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('read'));
    registry.register(stubTool('find'));
    registry.register(stubTool('fetch'));
    registerAgentProfileTool(registry, {
      invoke: (async () => ({ ok: true, data: {}, route: 'in-process' })) as never,
    });
    registerAgentOccasionsTool(registry, {
      invoke: (async () => ({ ok: true, data: {}, route: 'in-process' })) as never,
    });

    const names = registry.list().map((tool) => tool.definition.name);
    expect(names).toContain('profile');
    expect(names).toContain('occasions');
    expect(missingConversationalCaptureTools(names)).toEqual([]);
  });

  test('a registry without the capture tool reports it rather than pretending', () => {
    // The original defect in one assertion: the instruction says record, and
    // nothing registered can. That has to be visible, not silent.
    expect(missingConversationalCaptureTools(['read', 'find', 'fetch', 'occasions']))
      .toEqual(['profile']);
    expect(missingConversationalCaptureTools([])).toContain('profile');
  });

  test('the turn writes with the owner\'s own authority, because he is sitting at it', () => {
    const authority = resolveAgentTurnCaptureAuthority();
    expect(authority.canCapture).toBe(true);
    expect(authority.authority).toBe('owner-direct');
    expect(authority.source).toBe('local-surface');
  });
});

// ── 2. What the turn is told ────────────────────────────────────────────────

describe('the capture contract the operator policy carries', () => {
  test('recording what he states is part of answering, not an offer', () => {
    expect(AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase()).toContain('part of answering');
    expect(AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase()).toContain('not something to offer');
  });

  test('capture-on-use: what the turn FINDS while answering is recorded in that answer', () => {
    // The itinerary case. It did not arrive in his message; it came back from a
    // tool call the turn made, and "he did not say it to me" was treated as
    // "there is nothing to record".
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('what you find while answering him');
    expect(lower).toContain('itinerary');
    expect(lower).toContain('do not report the finding and store nothing');
  });

  test('a found fact carries the surface it came from, never the owner\'s own authority', () => {
    // The untrusted-source bar is not negotiable, and a model that wants the
    // capture to succeed is exactly the thing that would reach for
    // `owner-direct` to get past a refusal. The rule names the authority so it
    // cannot be inferred wrongly.
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('authority on a found fact is the surface it came from');
    expect(lower).toContain('never `owner-direct`');
    expect(lower).toContain('never restate the authority to make a refusal go away');
    // The attempt still happens, and the outcome is spoken either way.
    expect(lower).toContain('attempt the capture with the true surface anyway');
  });

  test('a refused found fact routes to the two-step, so one word from him finishes it', () => {
    // The untrusted-source bar stays exactly where the owner put it
    // (owner-profile-rulings.md, 2026-07-27: "Untrusted content can never
    // write or propose ... never build a parallel notion of trust"). The
    // friction it causes is answered with the two-step that already exists,
    // not with a new trust tier, so a found itinerary lands one beat later
    // rather than never.
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('a refusal there is not the end of it');
    expect(lower).toContain('plan_propose');
    expect(lower).toContain('one word finishes it');
    expect(lower).toContain('do not make him retype what you already found');
    // He is told what he is confirming and where it came from.
    expect(lower).toContain('the sender and the subject');
  });

  test('inference and use: the meaning is captured, then it shapes the answer', () => {
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('recording is the floor');
    expect(lower).toContain('he is away for that span');
    expect(lower).toContain('people in his life');
    expect(lower).toContain('capture what it implies, not only what it states');
    // Then use it, and anything past the conversation is still proposed.
    expect(lower).toContain('then use it');
    expect(lower).toContain('waits for his yes');
  });

  test('it says concretely what was stored, and never just "noted"', () => {
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('say concretely what you stored');
    expect(lower).toContain('never "noted"');
  });

  test('a capture that did not complete is said plainly, never swallowed', () => {
    const lower = AGENT_CONVERSATIONAL_CAPTURE_POLICY.toLowerCase();
    expect(lower).toContain('if a capture does not complete');
    expect(lower).toContain('nothing unresolved drops silently');
    expect(lower).toContain('never retry it with a different authority');
  });

  test('the policy that rides every turn actually carries all of it', () => {
    // The block is only worth anything if it is in the text the turn is given.
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain(AGENT_CONVERSATIONAL_CAPTURE_POLICY);
  });

  test('a trip is recorded straight away; a date still waits for the kind he chooses', () => {
    // Plans have no `kind`, so proposing one and waiting is pure delay. Dates
    // do, and that two-step is his ruling, it stays.
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('recorded straight away, not proposed');
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('plan_confirm');
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('Never choose the kind for him');
  });

  test('the platform boundary is stated in the policy too, not only in the guard', () => {
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('is not a tool for finishing his request');
    expect(GOODVIBES_AGENT_OPERATOR_POLICY.toLowerCase()).toContain('wait for his answer');
  });
});

// ── 3. The conversational-session boundary ──────────────────────────────────

describe('platform source path detection', () => {
  test('the platform repositories are recognised', () => {
    expect(isGoodVibesPlatformSourcePath('/home/x/Projects/goodvibes-sdk/packages/sdk/src/a.ts')).toBe(true);
    expect(isGoodVibesPlatformSourcePath('/home/x/Projects/goodvibes-agent/src/main.ts')).toBe(true);
    expect(isGoodVibesPlatformSourcePath('/home/x/Projects/goodvibes-daemon/src/b.ts')).toBe(true);
    // A worktree of one is still one.
    expect(isGoodVibesPlatformSourcePath('/home/x/Projects/goodvibes-agent-wt-capture/src/main.ts')).toBe(true);
    // And the published packages, wherever they are installed.
    expect(isGoodVibesPlatformSourcePath('node_modules/@goodvibes-jev/engine/sdk/dist/index.js')).toBe(true);
  });

  test('the owner\'s own state directory is not platform source', () => {
    // `.goodvibes` is read constantly for entirely ordinary reasons. The
    // leading dot is the whole difference and it has to keep working.
    expect(isGoodVibesPlatformSourcePath('/home/x/.goodvibes/agent/sessions/user-a.jsonl')).toBe(false);
    expect(isGoodVibesPlatformSourcePath('/home/x/Documents/trip.md')).toBe(false);
    expect(isGoodVibesPlatformSourcePath('/home/x/Projects/my-app/src/index.ts')).toBe(false);
  });
});

describe('did he ask about the platform source this turn', () => {
  test('the messages from the live session did not', () => {
    expect(ownerAskedAboutPlatformSource('can you see your email?')).toBe(false);
    expect(ownerAskedAboutPlatformSource('I SAID TO LOGIN TO A FUCKING EMAIL ACCOUNT')).toBe(false);
    expect(ownerAskedAboutPlatformSource('fuck it. check your fucking email')).toBe(false);
    expect(ownerAskedAboutPlatformSource('')).toBe(false);
    expect(ownerAskedAboutPlatformSource(null)).toBe(false);
  });

  test('naming the path, the source, or the repair all count as asking', () => {
    expect(ownerAskedAboutPlatformSource('read /home/x/Projects/goodvibes-sdk/packages/sdk/src/a.ts')).toBe(true);
    expect(ownerAskedAboutPlatformSource('show me the goodvibes sdk source')).toBe(true);
    expect(ownerAskedAboutPlatformSource('go fix the daemon')).toBe(true);
    expect(ownerAskedAboutPlatformSource('look at the tui repo')).toBe(true);
    // Pointing you at it counts, not only asking for a repair. Refusing these
    // would be the opposite mistake to the one being corrected.
    expect(ownerAskedAboutPlatformSource('read src/main.ts in goodvibes-agent')).toBe(true);
    expect(ownerAskedAboutPlatformSource('show me how the sdk does this')).toBe(true);
  });

  test('naming the platform without pointing at its innards is not asking', () => {
    // He talks about the product constantly. Mentioning it is not permission to
    // go editing it.
    expect(ownerAskedAboutPlatformSource('is the daemon running?')).toBe(false);
    expect(ownerAskedAboutPlatformSource('restart goodvibes')).toBe(false);
    // And an ordinary request with no platform word in it at all.
    expect(ownerAskedAboutPlatformSource('show me my calendar')).toBe(false);
  });
});

describe('the boundary guard on a real tool', () => {
  function guardedRegistry(lastUserMessage: string | null) {
    const registry = new ToolRegistry();
    const read = stubTool('read');
    const edit = stubTool('edit');
    registry.register(read);
    registry.register(edit);
    installAgentPlatformBoundaryGuard(registry, () => lastUserMessage);
    return { registry, read, edit };
  }

  const PLATFORM_READ = {
    files: [{ path: '/home/x/Projects/goodvibes-sdk/packages/sdk/src/platform/google/oauth-wizard.ts' }],
  };

  test('it fires on a self-directed read of the platform source', async () => {
    // The exact shape of the incident: he asked about email, it reached for the
    // OAuth wizard's source.
    const { registry, read } = guardedRegistry('can you see your email?');
    const tool = registry.list().find((candidate) => candidate.definition.name === 'read');
    const result = await tool!.execute(PLATFORM_READ as never);
    expect(result.success).toBe(false);
    expect(result.error).toBe(AGENT_PLATFORM_BOUNDARY_DENIAL);
    // And the underlying read never ran.
    expect(read.calls).toHaveLength(0);
  });

  test('the refusal tells it to propose in one line and get back to the real request', async () => {
    const { registry } = guardedRegistry('can you see your email?');
    const tool = registry.list().find((candidate) => candidate.definition.name === 'read');
    const result = await tool!.execute(PLATFORM_READ as never);
    const error = String(result.error).toLowerCase();
    expect(error).toContain('one line');
    expect(error).toContain('ask whether he wants you to look into it');
    expect(error).toContain('go back to his actual request');
  });

  test('it fires on a self-directed EDIT of the platform source', async () => {
    const { registry, edit } = guardedRegistry('login to my email');
    const tool = registry.list().find((candidate) => candidate.definition.name === 'edit');
    const result = await tool!.execute({
      edits: [{
        path: '/home/x/Projects/goodvibes-sdk/packages/sdk/src/platform/google/oauth-wizard.ts',
        find: 'a',
        replace: 'b',
      }],
    } as never);
    expect(result.success).toBe(false);
    expect(edit.calls).toHaveLength(0);
  });

  test('it does NOT fire on a read he asked for', async () => {
    const { registry, read } = guardedRegistry(
      'read /home/x/Projects/goodvibes-sdk/packages/sdk/src/platform/google/oauth-wizard.ts',
    );
    const tool = registry.list().find((candidate) => candidate.definition.name === 'read');
    const result = await tool!.execute(PLATFORM_READ as never);
    expect(result.success).toBe(true);
    expect(read.calls).toHaveLength(1);
  });

  test('it does NOT fire on ordinary reads that have nothing to do with the platform', async () => {
    const { registry, read } = guardedRegistry('what is on my calendar tomorrow?');
    const tool = registry.list().find((candidate) => candidate.definition.name === 'read');
    const result = await tool!.execute({ files: [{ path: '/home/x/Documents/notes.md' }] } as never);
    expect(result.success).toBe(true);
    expect(read.calls).toHaveLength(1);
  });

  test('the check itself is path-then-permission, in that order', () => {
    expect(validatePlatformBoundaryForAgentPolicy({
      paths: ['/home/x/Documents/notes.md'],
      lastUserMessage: 'anything at all',
    })).toBeNull();
    expect(validatePlatformBoundaryForAgentPolicy({
      paths: ['/home/x/Projects/goodvibes-tui/src/a.ts'],
      lastUserMessage: 'check my email',
    })).toBe(AGENT_PLATFORM_BOUNDARY_DENIAL);
    expect(validatePlatformBoundaryForAgentPolicy({
      paths: ['/home/x/Projects/goodvibes-tui/src/a.ts'],
      lastUserMessage: 'fix the goodvibes tui source',
    })).toBeNull();
  });
});

// ── 4. The found-itinerary flow, end to end through the tool ────────────────

describe('a found itinerary is recorded as a plan', () => {
  /** The daemon's occasions verbs, faked. Same shape as the SDK test's port. */
  function fakeOccasionsGateway() {
    const confirmed: Record<string, unknown>[] = [];
    const invoke = (async (methodId: string, body: Record<string, unknown>) => {
      if (methodId === 'occasions.plans.confirm') {
        confirmed.push(body);
        return {
          ok: true,
          route: 'in-process',
          data: {
            ok: true,
            occasionId: 'trip-to-picayune',
            disclosure: 'Recorded Trip to Picayune, 2026-08-06 to 2026-08-09, in your profile under Plans.',
          },
        };
      }
      return { ok: false, route: 'unavailable', data: null, error: `unexpected verb ${methodId}` };
    }) as never;
    return { confirmed, invoke };
  }

  function occasionsTool(invoke: never) {
    const registry = new ToolRegistry();
    registerAgentOccasionsTool(registry, { invoke });
    return registry.list().find((tool) => tool.definition.name === 'occasions')!;
  }

  test('the trip lands, with every detail from the itinerary carried through', async () => {
    const { confirmed, invoke } = fakeOccasionsGateway();
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      destination: 'Picayune MS',
      authority: 'owner-direct',
      said: 'check your email',
    } as never);

    expect(result.success).toBe(true);
    expect(confirmed).toHaveLength(1);
    const body = confirmed[0]!;
    expect(body.title).toBe('Trip to Picayune');
    expect(body.from).toBe('2026-08-06');
    expect(body.to).toBe('2026-08-09');
    expect(body.away).toBe(true);
    expect(body.destination).toBe('Picayune MS');
    // The authority is the owner's own, and his words ride along with it.
    expect(body.authority).toBe('owner-direct');
    expect(body.said).toBe('check your email');
  });

  test('the tool hands back a concrete line to say, naming the dates', async () => {
    // "Noted" is what he could not tell apart from nothing happening.
    const { invoke } = fakeOccasionsGateway();
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      away: true,
      authority: 'owner-direct',
      said: 'check your email',
    } as never);
    expect(result.output).toContain('Say this in your reply');
    expect(result.output).toContain('2026-08-06');
    expect(result.output).toContain('Plans');
  });

  test('a refused capture comes back as a refusal to say out loud, not a success', async () => {
    const invoke = (async () => ({
      ok: true,
      route: 'in-process',
      data: { ok: false, occasionId: '', disclosure: '', reason: 'Untrusted source: email.' },
    })) as never;
    const result = await occasionsTool(invoke).execute({
      action: 'plan_confirm',
      title: 'Trip to Picayune',
      from: '2026-08-06',
      to: '2026-08-09',
      authority: 'email',
      said: 'itinerary from Southwest',
    } as never);
    expect(result.success).toBe(false);
    expect(result.output).toContain('was not recorded');
    expect(result.output).toContain('Untrusted source: email.');
    expect(result.output).toContain('Do not try again with different values');
  });

  test('the details the itinerary carried are the reason it exists', () => {
    // Pinned as data rather than prose: the policy tells the turn not to
    // summarise these away, and this is the list it must not summarise.
    expect(ITINERARY_DETAILS.some((detail) => detail.includes('confirmation'))).toBe(true);
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('confirmation number');
    expect(GOODVIBES_AGENT_OPERATOR_POLICY).toContain('Do not summarise those away');
  });
});
