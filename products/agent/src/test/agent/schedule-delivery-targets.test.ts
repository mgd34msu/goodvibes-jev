/**
 * The delivery-target vocabulary used to exist as six hand-maintained copies
 * across the schedule commands, and they had already drifted. These tests pin
 * the properties that make a seventh copy impossible: one runtime list, a type
 * derived from it, and every command parsing through the same functions.
 */
import { describe, expect, test } from 'bun:test';
import { parseAutonomyScheduleArgs } from '../../agent/autonomy-schedule.ts';
import { parseReminderScheduleArgs } from '../../agent/reminder-schedule.ts';
import { parseRoutineSchedulePromotionArgs } from '../../agent/routine-schedule-args.ts';
import {
  DELIVERY_SURFACE_KINDS,
  isRoutineScheduleDeliverySurfaceKind,
  parseChannelDeliveryTarget,
  validateDeliveryTargets,
} from '../../agent/schedule-delivery-targets.ts';

describe('the delivery-surface list has exactly one definition', () => {
  test('the surface-kind type is derived from the runtime list, so the two cannot disagree', () => {
    // A type error here (not a runtime failure) is the point: adding a member
    // to the list widens the type automatically.
    const everyKind: readonly (typeof DELIVERY_SURFACE_KINDS)[number][] = DELIVERY_SURFACE_KINDS;
    expect(everyKind).toHaveLength(DELIVERY_SURFACE_KINDS.length);
    for (const kind of DELIVERY_SURFACE_KINDS) {
      expect(isRoutineScheduleDeliverySurfaceKind(kind)).toBe(true);
    }
    expect(isRoutineScheduleDeliverySurfaceKind('not-a-channel')).toBe(false);
  });
});

describe('every schedule command parses delivery targets identically', () => {
  const commands = [
    { name: 'reminder', parse: (args: readonly string[]) => parseReminderScheduleArgs(['Water the plants', ...args]) },
    {
      name: 'autonomy',
      parse: (args: readonly string[]) =>
        parseAutonomyScheduleArgs([
          '--task',
          'Tidy inbox',
          '--success-criteria',
          'Inbox is empty and a summary is posted.',
          '--explicit-user-request',
          'Please tidy my inbox every morning.',
          ...args,
        ]),
    },
    { name: 'routine promotion', parse: (args: readonly string[]) => parseRoutineSchedulePromotionArgs(['nightly', ...args]) },
  ] as const;

  for (const command of commands) {
    test(`${command.name} accepts every supported channel and rejects an unsupported one`, () => {
      for (const kind of DELIVERY_SURFACE_KINDS) {
        const parsed = command.parse(['--cron', '0 9 * * *', '--delivery-channel', kind]);
        expect(parsed.deliveryTargets).toEqual([{ kind: 'surface', surfaceKind: kind, routeId: undefined, label: undefined }]);
        expect(parsed.errors).toEqual([]);
      }
      const rejected = command.parse(['--cron', '0 9 * * *', '--delivery-channel', 'carrier-pigeon']);
      expect(rejected.errors).toContain('Unsupported delivery channel "carrier-pigeon".');
    });

    test(`${command.name} rejects mixing delivery target kinds`, () => {
      const parsed = command.parse([
        '--cron',
        '0 9 * * *',
        '--delivery-channel',
        'slack',
        '--delivery-webhook',
        'https://example.test/hook',
      ]);
      expect(parsed.errors.some((error) => error.startsWith('Use one delivery target kind per '))).toBe(true);
    });
  }
});

describe('validateDeliveryTargets', () => {
  test('names the command in the message so each surface keeps its own wording', () => {
    const mixed = [
      parseChannelDeliveryTarget('slack'),
      { kind: 'webhook' as const, address: 'https://example.test/hook' },
    ].filter((target): target is Exclude<typeof target, string> => typeof target !== 'string');
    expect(validateDeliveryTargets(mixed, 'reminder command')).toBe('Use one delivery target kind per reminder command.');
    expect(validateDeliveryTargets(mixed, 'autonomous schedule command')).toBe(
      'Use one delivery target kind per autonomous schedule command.',
    );
  });

  test('accepts targets that share a kind', () => {
    const target = parseChannelDeliveryTarget('slack');
    expect(typeof target).not.toBe('string');
    expect(validateDeliveryTargets([target as Exclude<typeof target, string>], 'reminder command')).toBeNull();
  });
});
