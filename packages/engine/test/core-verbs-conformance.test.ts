/**
 * core-verbs-conformance.test.ts, the core-verb command spec conformance lint.
 *
 * The forcing function for packages/contracts/src/core-verbs.ts: every id in
 * OPERATOR_METHOD_IDS must classify as either a core verb, an explicitly
 * exempted domain verb (in a documented category), or the test fails and
 * names the offending id(s), a new ad hoc verb, or a banned verb making a
 * comeback, cannot land silently. See core-verbs.ts's module doc for the
 * design rationale and docs/decisions/2026-07-06-core-verb-spec.md for the
 * ranked worst-class collisions this pass fixed.
 */
import { describe, expect, test } from 'bun:test';
import { OPERATOR_METHOD_IDS } from '../contracts/src/generated/operator-method-ids.js';
import {
  BANNED_VERBS,
  CORE_VERBS,
  EXEMPT_VERB_CATEGORIES,
  EXEMPT_VERBS,
  SCOPED_EXEMPT_VERB_CATEGORIES,
  classifyVerb,
  verbTailOf,
} from '../contracts/src/core-verbs.js';

describe('core-verbs conformance', () => {
  test('every OPERATOR_METHOD_IDS verb tail is core, exempt, or explains itself', () => {
    const unclassified: string[] = [];
    for (const id of OPERATOR_METHOD_IDS) {
      const classification = classifyVerb(id);
      if (classification.kind === 'unclassified') {
        unclassified.push(`${id} (tail: "${classification.verb}")`);
      }
    }
    expect(
      unclassified,
      `Found ${unclassified.length} operator method id(s) whose verb tail is neither in ` +
        `CORE_VERBS nor in an EXEMPT_VERB_CATEGORIES entry: ${unclassified.join(', ')}. ` +
        `Either the verb belongs in CORE_VERBS (if it's a generic lifecycle verb reused ` +
        `across families), in an existing exempt category, or needs a new documented ` +
        `category in packages/contracts/src/core-verbs.ts.`,
    ).toEqual([]);
  });

  test('no id revives a retired generic alias outside an exact distinct operation', () => {
    const offenders = OPERATOR_METHOD_IDS.filter((id) => classifyVerb(id).kind === 'banned');
    expect(
      offenders,
      `These ids use a retired verb (${BANNED_VERBS.join(', ')}): ${offenders.join(', ')}. ` +
        `See core-verbs.ts's BANNED_VERBS doc comment for the canonical replacement.`,
    ).toEqual([]);
  });

  test('CORE_VERBS and BANNED_VERBS never overlap', () => {
    const overlap = CORE_VERBS.filter((verb) => (BANNED_VERBS as readonly string[]).includes(verb));
    expect(overlap).toEqual([]);
  });

  test('delegated Telegram configuration is an exact retention-selection operation', () => {
    expect(classifyVerb('inbound.telegram.configure')).toEqual({ kind: 'exempt', verb: 'configure', category: 'delegated-telegram-source-retention-selection' });
    expect(EXEMPT_VERBS.has('configure')).toBe(false);
    for (const id of ['inbound.configure', 'inbound.slack.configure', 'inbound.telegram.child.configure', 'tasks.configure']) expect(classifyVerb(id).kind).toBe('unclassified');
  });

  test('native host discovery and durable recovery are exact method-id classifications', () => {
    expect(classifyVerb('workLedger.project')).toEqual({ kind: 'exempt', verb: 'project', category: 'native-work-project-discovery' });
    expect(classifyVerb('workLedger.execution.resume')).toEqual({ kind: 'exempt', verb: 'resume', category: 'native-work-durable-recovery' });
    for (const [category, id] of [
      ['native-work-project-discovery', 'workLedger.project'],
      ['native-work-durable-recovery', 'workLedger.execution.resume'],
    ] as const) {
      expect(OPERATOR_METHOD_IDS.filter(method => {
        const result = classifyVerb(method);
        return result.kind === 'exempt' && result.category === category;
      })).toEqual([id]);
    }
    expect(EXEMPT_VERBS.has('project')).toBe(false);
    expect(EXEMPT_VERBS.has('resume')).toBe(false);
    for (const id of ['workLedgerExtra.project', 'workLedger.child.project', 'sessions.project', 'constructor', '__proto__', 'toString']) {
      expect(classifyVerb(id).kind).toBe('unclassified');
    }
  });

  test('source submission is one exact domain operation, without a generic submit alias', () => {
    expect(classifyVerb('workLedger.submit')).toEqual({ kind: 'exempt', verb: 'submit', category: 'native-work-source-submission' });
    expect(EXEMPT_VERBS.has('submit')).toBe(false);
    for (const id of ['workLedgerExtra.submit', 'workLedger.child.submit', 'tasks.submit', 'sessions.submit']) expect(classifyVerb(id).kind).toBe('unclassified');
    expect(classifyVerb('workLedger.submission.get').kind).toBe('core');
  });

  test('conversation capture, admission and recovery are exact operations without generic aliases', () => {
    for (const [verb, category] of [['capture', 'native-conversation-source-capture'], ['admit', 'native-conversation-semantic-admission'], ['resume', 'native-conversation-durable-recovery']] as const) {
      expect(classifyVerb(`workLedger.intake.${verb}`)).toEqual({ kind: 'exempt', verb, category });
      for (const id of [`workLedger.intake.child.${verb}`, `workLedgerExtra.intake.${verb}`, `tasks.${verb}`]) expect(classifyVerb(id).kind).toBe(verb === 'resume' ? 'banned' : 'unclassified');
    }
  });

  test('Agent hosted delivery is an exact method without a generic surface-start alias', () => {
    expect(classifyVerb('workLedger.turn.startAgent')).toEqual({ kind: 'exempt', verb: 'startAgent', category: 'native-conversation-agent-delivery' });
    expect(EXEMPT_VERBS.has('startAgent')).toBe(false);
    for (const id of ['workLedger.startAgent', 'workLedger.turn.child.startAgent', 'workLedgerExtra.turn.startAgent', 'sessions.startAgent']) {
      expect(classifyVerb(id).kind).toBe('unclassified');
    }
    expect(OPERATOR_METHOD_IDS.filter(id => {
      const result = classifyVerb(id);
      return result.kind === 'exempt' && result.category === 'native-conversation-agent-delivery';
    })).toEqual(['workLedger.turn.startAgent']);
  });

  test('retired automation aliases and native recovery lookalikes remain banned', () => {
    expect(BANNED_VERBS as readonly string[]).toContain('resume');
    for (const id of ['automation.jobs.resume', 'automation.jobs.pause', 'automation.jobs.patch', 'tasks.resume', 'workLedger.resume', 'workLedger.execution.child.resume', 'workLedgerExtra.execution.resume']) {
      expect(classifyVerb(id).kind).toBe('banned');
    }
    expect(OPERATOR_METHOD_IDS.filter(id => (BANNED_VERBS as readonly string[]).includes(verbTailOf(id))))
      .toEqual(['workLedger.execution.resume', 'workLedger.intake.resume']);
  });

  test('no verb is exempted under more than one category', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const [category, verbs] of Object.entries(EXEMPT_VERB_CATEGORIES)) {
      for (const verb of verbs) {
        const existing = seen.get(verb);
        if (existing) conflicts.push(`"${verb}" in both "${existing}" and "${category}"`);
        else seen.set(verb, category);
      }
    }
    expect(conflicts).toEqual([]);
  });

  // A generic tail is granted per NAMESPACE, so the same word appearing under
  // two scoped categories is the mechanism working. What must never repeat is
  // one namespace+verb pair being decided twice, or a tail carrying both a
  // repo-wide grant and a scoped one, the scoped entry would then be decoration.
  test('a scoped exemption is decided exactly once per namespace and verb', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const [category, exemption] of Object.entries(SCOPED_EXEMPT_VERB_CATEGORIES)) {
      for (const namespace of exemption.namespaces) {
        for (const verb of exemption.verbs) {
          const key = `${namespace}.${verb}`;
          const existing = seen.get(key);
          if (existing) conflicts.push(`"${key}" in both "${existing}" and "${category}"`);
          else seen.set(key, category);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  test('no verb is exempted both repo-wide and under a namespace', () => {
    const repoWide = new Set(Object.values(EXEMPT_VERB_CATEGORIES).flat());
    const overlap = Object.values(SCOPED_EXEMPT_VERB_CATEGORIES)
      .flatMap((exemption) => exemption.verbs)
      .filter((verb) => repoWide.has(verb));
    expect(overlap).toEqual([]);
  });

  test('a scoped verb is refused outside the namespaces it was granted in', () => {
    // The defect this mechanism closes: `occasions.remove` and
    // `workspaces.registrations.remove` both landed on a rationale written
    // entirely about `mcp.servers.remove`.
    expect(classifyVerb('mcp.servers.remove').kind).toBe('exempt');
    expect(classifyVerb('occasions.remove').kind).toBe('exempt');
    expect(classifyVerb('workspaces.registrations.remove').kind).toBe('exempt');
    expect(classifyVerb('memory.records.add').kind).toBe('exempt');
    expect(classifyVerb('memory.records.links.add').kind).toBe('exempt');

    expect(classifyVerb('watchers.remove').kind).toBe('unclassified');
    expect(classifyVerb('skills.add').kind).toBe('unclassified');
    // Boundary-aware: a namespace grant does not leak to a longer sibling name.
    expect(classifyVerb('workspaces.registrationsExtra.remove').kind).toBe('unclassified');
  });

  test('durable event history vocabulary is scoped to the work ledger', () => {
    expect(classifyVerb('workLedger.history')).toEqual({
      kind: 'exempt', verb: 'history', category: 'work-ledger-event-history',
    });
    expect(OPERATOR_METHOD_IDS.filter((id) => {
      const classification = classifyVerb(id);
      return classification.kind === 'exempt' && classification.category === 'work-ledger-event-history';
    })).toEqual(['workLedger.history']);
    expect(classifyVerb('workLedgerExtra.history').kind).toBe('unclassified');
    expect(classifyVerb('sessions.history').kind).toBe('unclassified');
  });

  test('legacy import vocabulary is scoped to the work ledger', () => {
    for (const verb of ['prepareLegacyImport', 'importLegacy']) {
      expect(classifyVerb(`workLedger.${verb}`)).toEqual({
        kind: 'exempt', verb, category: 'work-ledger-legacy-import',
      });
      expect(classifyVerb(`workLedgerExtra.${verb}`).kind).toBe('unclassified');
      expect(classifyVerb(`sessions.${verb}`).kind).toBe('unclassified');
    }
    expect(OPERATOR_METHOD_IDS.filter((id) => {
      const classification = classifyVerb(id);
      return classification.kind === 'exempt' && classification.category === 'work-ledger-legacy-import';
    })).toEqual(['workLedger.importLegacy', 'workLedger.prepareLegacyImport']);
  });

  test('every scoped exemption names at least one live method id', () => {
    const stale: string[] = [];
    for (const [category, exemption] of Object.entries(SCOPED_EXEMPT_VERB_CATEGORIES)) {
      for (const namespace of exemption.namespaces) {
        for (const verb of exemption.verbs) {
          const covered = OPERATOR_METHOD_IDS.some(
            (id) => id.startsWith(`${namespace}.`) && verbTailOf(id) === verb,
          );
          if (!covered) stale.push(`${category}: ${namespace}.* ${verb}`);
        }
      }
    }
    expect(
      stale,
      `These scoped exemptions grant a verb no live method id uses: ${stale.join(', ')}. ` +
        `An exemption that outlives the id it was written for is a standing grant nobody decided on.`,
    ).toEqual([]);
  });

  test('no exempt verb is also a core verb', () => {
    const coreSet = new Set<string>(CORE_VERBS);
    const conflicts: string[] = [];
    for (const [category, verbs] of Object.entries(EXEMPT_VERB_CATEGORIES)) {
      for (const verb of verbs) {
        if (coreSet.has(verb)) conflicts.push(`"${verb}" is in CORE_VERBS and also exempted under "${category}"`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  // ── Regression guards for the specific worst-class collision fixes ──

  test('SCHEDULE: no bare top-level "schedules.*" family remains (collision #1)', () => {
    const bareSchedules = OPERATOR_METHOD_IDS.filter((id) => id.startsWith('schedules.'));
    expect(
      bareSchedules,
      'The bare "schedules.*" namespace was renamed to "automation.schedules.*" in the 1.0.0 core-verb rename ' +
        'to stop colliding with the agent reminder/routine tooling and with knowledge.schedule(s).*.',
    ).toEqual([]);
  });

  test('SCHEDULE: automation.schedules.* and automation.jobs.* both exist as the two automation families', () => {
    const automationSchedules = OPERATOR_METHOD_IDS.filter((id) => id.startsWith('automation.schedules.'));
    const automationJobs = OPERATOR_METHOD_IDS.filter((id) => id.startsWith('automation.jobs.'));
    expect(automationSchedules.length).toBeGreaterThan(0);
    expect(automationJobs.length).toBeGreaterThan(0);
  });

  test('SCHEDULE: knowledge scheduling stays namespaced under knowledge.* (disambiguated by namespace, not renamed)', () => {
    const knowledgeSchedule = OPERATOR_METHOD_IDS.filter((id) => id.startsWith('knowledge.schedule'));
    expect(knowledgeSchedule.length).toBeGreaterThan(0);
  });

  test('update-verb split: no id uses "patch" anywhere (automation.jobs, routes.bindings, watchers all moved to "update")', () => {
    const updateFamilies = ['automation.jobs.update', 'routes.bindings.update', 'watchers.update'];
    for (const id of updateFamilies) {
      expect(OPERATOR_METHOD_IDS as readonly string[], `expected ${id} to exist`).toContain(id);
    }
  });

  test('redundant lifecycle pair: automation.jobs has enable/disable but not pause/resume', () => {
    expect(OPERATOR_METHOD_IDS as readonly string[]).toContain('automation.jobs.enable');
    expect(OPERATOR_METHOD_IDS as readonly string[]).toContain('automation.jobs.disable');
    expect(OPERATOR_METHOD_IDS as readonly string[]).not.toContain('automation.jobs.pause');
    expect(OPERATOR_METHOD_IDS as readonly string[]).not.toContain('automation.jobs.resume');
  });
});
