import type { ParsedRoutineSchedulePromotionArgs } from './routine-schedule-promotion.ts';
import {
  parseChannelDeliveryTarget,
  parseLinkDeliveryTarget,
  parseRouteDeliveryTarget,
  parseWebhookDeliveryTarget,
  readOptionValue as optionValue,
  validateDeliveryTargets,
  type RoutineScheduleDeliveryTargetSpec,
} from './schedule-delivery-targets.ts';

export { isRoutineScheduleDeliverySurfaceKind } from './schedule-delivery-targets.ts';

export function parseRoutineSchedulePromotionArgs(args: readonly string[]): ParsedRoutineSchedulePromotionArgs {
  let routineId: string | null = null;
  let schedule: ParsedRoutineSchedulePromotionArgs['schedule'] = null;
  const deliveryTargets: RoutineScheduleDeliveryTargetSpec[] = [];
  let name: string | undefined;
  let timezone: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let enabled = true;
  let yes = false;
  const errors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? '';
    const equals = raw.indexOf('=');
    const optionName = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;

    if (raw === '--yes') {
      yes = true;
      continue;
    }
    if (raw === '--disabled') {
      enabled = false;
      continue;
    }
    if (optionName === '--name' || optionName === '--timezone' || optionName === '--provider' || optionName === '--model') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      if (optionName === '--name') name = value;
      if (optionName === '--timezone') timezone = value;
      if (optionName === '--provider') provider = value;
      if (optionName === '--model') model = value;
      continue;
    }
    if (optionName === '--cron' || optionName === '--every' || optionName === '--at') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      if (schedule) {
        errors.push('Choose exactly one schedule selector: --cron, --every, or --at.');
        continue;
      }
      schedule = {
        kind: optionName === '--cron' ? 'cron' : optionName === '--every' ? 'every' : 'at',
        value,
      };
      continue;
    }
    if (
      optionName === '--delivery-channel'
      || optionName === '--deliver-channel'
    ) {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseChannelDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-route' || optionName === '--deliver-route') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseRouteDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-webhook' || optionName === '--deliver-webhook') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseWebhookDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (optionName === '--delivery-link' || optionName === '--deliver-link') {
      const consumed = optionValue(args, index, inlineValue);
      index = consumed.nextIndex;
      const value = consumed.value?.trim();
      if (!value) {
        errors.push(`${optionName} requires a value.`);
        continue;
      }
      const target = parseLinkDeliveryTarget(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
      continue;
    }
    if (raw.startsWith('--')) {
      errors.push(`Unknown option ${raw}`);
      continue;
    }
    if (!routineId) {
      routineId = raw;
      continue;
    }
    errors.push(`Unexpected argument: ${raw}`);
  }

  if (!routineId) errors.push('Routine id or name is required.');
  if (!schedule) errors.push('Schedule is required: use --cron <expr>, --every <interval>, or --at <iso-time>.');
  const deliveryError = validateDeliveryTargets(deliveryTargets, 'routine promotion command');
  if (deliveryError) errors.push(deliveryError);
  return { routineId, schedule, deliveryTargets, name, timezone, provider, model, enabled, yes, errors };
}
