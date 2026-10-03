import { describe, expect, test } from 'bun:test';
import { AgentRoutineRegistry, buildEnabledRoutinesPrompt, evaluateAgentRoutineReadiness } from '../../agent/routine-registry.ts';
import { formatAgentSkillRequirement } from '../../agent/skill-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempRegistry(): { readonly registry: AgentRoutineRegistry; readonly paths: ReturnType<typeof createShellPathService> } {
  const root = makeProjectTempDir('goodvibes-agent-routines');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return { registry: AgentRoutineRegistry.fromShellPaths(paths), paths };
}

describe('AgentRoutineRegistry', () => {
  test('creates, enables, starts, reviews, marks stale, and deletes local routines', () => {
    const { registry } = tempRegistry();
    const routine = registry.create({
      name: 'Evening Review',
      description: 'Review open work before shutdown.',
      steps: 'Check work plan, pending approvals, and unresolved reminders. Summarize only.',
      tags: ['daily', 'review', 'daily'],
      triggers: ['evening'],
    });

    expect(routine.id).toBe('evening-review');
    expect(routine.tags).toEqual(['daily', 'review']);
    expect(registry.snapshot().enabledRoutines).toHaveLength(0);

    expect(registry.setEnabled('evening-review', true).enabled).toBe(true);
    expect(registry.snapshot().enabledRoutines).toHaveLength(1);
    const started = registry.markStarted('Evening Review');
    expect(started.startCount).toBe(1);
    expect(Number.isNaN(Date.parse(started.lastStartedAt ?? ''))).toBe(false);
    expect(registry.markReviewed('evening-review').reviewState).toBe('reviewed');
    expect(registry.markStale('evening-review', 'Needs reminder coverage.').staleReason).toContain('reminder');
    expect(registry.deleteRoutine('evening-review').id).toBe('evening-review');
    expect(registry.list()).toHaveLength(0);
  });

  test('pins delete/get behavior: get is absent after delete, and deleting a nonexistent routine fails honestly', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Weekly Review',
      description: 'Review the week before planning ahead.',
      steps: 'Check work plan, approvals, and unresolved reminders. Summarize only.',
    });

    expect(registry.get('weekly-review')).not.toBeNull();
    const deleted = registry.deleteRoutine('weekly-review');
    expect(deleted.id).toBe('weekly-review');
    expect(registry.get('weekly-review')).toBeNull();

    expect(() => registry.deleteRoutine('weekly-review')).toThrow('Unknown routine weekly-review');
    expect(() => registry.deleteRoutine('never-existed')).toThrow('Unknown routine never-existed');
  });

  test('rejects duplicates and secret-looking routine steps', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Status Sweep',
      description: 'Inspect visible state.',
      steps: 'Read status, work plan, and approvals before responding.',
    });

    expect(() => registry.create({
      name: 'status sweep',
      description: 'Duplicate.',
      steps: 'Duplicate.',
    })).toThrow('Routine already exists');

    expect(() => registry.create({
      name: 'Secret Routine',
      description: 'Invalid.',
      steps: 'api_key=secret-value',
    })).toThrow('secret-looking');
  });

  test('builds reviewed setup-ready enabled routine prompt without background jobs or default knowledge coupling', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Daily Operator Brief',
      description: 'Summarize operator state.',
      steps: 'Use read-only status, work plan, approvals, and Agent Knowledge status before summarizing.',
      triggers: ['daily', 'briefing'],
      enabled: true,
    });
    registry.markReviewed('daily-operator-brief');

    const prompt = buildEnabledRoutinesPrompt(paths);

    expect(prompt).toContain('Enabled GoodVibes Agent Routines');
    expect(prompt).toContain('Daily Operator Brief');
    expect(prompt).toContain('Use only reviewed, setup-ready');
    expect(prompt).not.toContain('Suppressed Routines');
    expect(prompt).toContain('same serial assistant conversation');
    expect(prompt).toContain('Do not start hidden background jobs');
    expect(prompt).not.toContain('/api/knowledge');
    expect(prompt).not.toContain('non-Agent knowledge fallback');
  });

  test('suppresses unreviewed enabled routines from application prompt', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Unreviewed Routine',
      description: 'Should not steer behavior yet.',
      steps: 'This routine must not be applied before review.',
      enabled: true,
    });

    const prompt = buildEnabledRoutinesPrompt(paths);

    expect(prompt).toContain('Suppressed Routines Pending Review Or Setup');
    expect(prompt).toContain('Unreviewed Routine: review=Needs review');
    expect(prompt).toContain('Do not apply these routines');
    expect(prompt).not.toContain('This routine must not be applied before review.');
  });

  test('stores setup requirements and reports readiness without secret values', () => {
    const { registry, paths } = tempRegistry();
    const routine = registry.create({
      name: 'Weekly Research Review',
      description: 'Review research sources before planning.',
      steps: 'Collect source-backed changes, summarize gaps, and ask before sending anything.',
      requirements: [
        { kind: 'env', name: 'GOODVIBES_AGENT_TEST_MISSING_TOKEN' },
        { kind: 'command', name: 'definitely-missing-goodvibes-agent-routine-bin' },
      ],
      enabled: true,
    });

    const readiness = evaluateAgentRoutineReadiness(routine, {
      env: { GOODVIBES_AGENT_TEST_MISSING_TOKEN: 'redacted', PATH: '' },
      pathValue: '',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.met.map(formatAgentSkillRequirement)).toEqual(['env:GOODVIBES_AGENT_TEST_MISSING_TOKEN']);
    expect(readiness.missing.map(formatAgentSkillRequirement)).toEqual(['command:definitely-missing-goodvibes-agent-routine-bin']);

    const prompt = buildEnabledRoutinesPrompt(paths);
    expect(prompt).toContain('command:definitely-missing-goodvibes-agent-routine-bin');
    expect(prompt).toContain('Suppressed Routines Pending Review Or Setup');
    expect(prompt).not.toContain('redacted');
  });
});
