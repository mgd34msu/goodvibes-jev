/**
 * schedule-delivery-targets.ts, the delivery-target half of the schedule
 * domain, owned once.
 *
 * Four commands create or edit a connected-host schedule (reminder, autonomy,
 * routine promotion, schedule edit) and one sends to a channel directly. They
 * each used to carry their own copy of the supported-surface list, the four
 * `--delivery-*` parsers, the provider/model normalizer and the arg scanner.
 * The copies had already drifted, and nothing could have caught it: a sixth
 * channel kind added to five of six lists compiles clean and simply makes one
 * command reject input the others accept.
 *
 * The surface-kind TYPE is derived from the runtime list here rather than
 * written out a second time as a union, so the two cannot disagree either.
 * Every schedule delivery-target rule lives in this file; adding a channel is
 * one line.
 */

import type { OperatorMethodInput } from '@goodvibes-jev/engine/sdk/contracts';
import { getModelIdFromProviderModel, getProviderIdFromModel } from '../config/provider-model.ts';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleDeliveryInput = NonNullable<ScheduleCreateInput['delivery']>;
type ScheduleDeliveryTargetInput = ScheduleDeliveryInput['targets'] extends readonly (infer T)[] ? T : never;

/** Every channel surface a schedule may deliver to. The one list. */
export const DELIVERY_SURFACE_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
] as const;

export type RoutineScheduleDeliverySurfaceKind = (typeof DELIVERY_SURFACE_KINDS)[number];

export type RoutineScheduleDeliveryKind = 'webhook' | 'surface' | 'integration' | 'link';

export interface RoutineScheduleDeliveryTargetSpec {
  readonly kind: RoutineScheduleDeliveryKind;
  readonly surfaceKind?: RoutineScheduleDeliverySurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export function isRoutineScheduleDeliverySurfaceKind(value: string): value is RoutineScheduleDeliverySurfaceKind {
  return (DELIVERY_SURFACE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Argument scanning
// ---------------------------------------------------------------------------

/**
 * The value for the option at `index`, whether it arrived as `--flag=value` or
 * as a following argument. Returns the index the caller's loop should resume
 * from, so a consumed following argument is not re-parsed as an option.
 */
export function readOptionValue(args: readonly string[], index: number, inlineValue: string | undefined): {
  readonly value: string | undefined;
  readonly nextIndex: number;
} {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

// ---------------------------------------------------------------------------
// Delivery-target parsing
// ---------------------------------------------------------------------------

/** Each parser returns a target, or the message explaining why the input is not one. */
export function parseChannelDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const [surfaceKind = '', routeId, label] = raw.split(':');
  if (!isRoutineScheduleDeliverySurfaceKind(surfaceKind)) {
    return `Unsupported delivery channel "${surfaceKind}".`;
  }
  return {
    kind: 'surface',
    surfaceKind,
    routeId: routeId?.trim() || undefined,
    label: label?.trim() || undefined,
  };
}

export function parseRouteDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const [routeId = '', label] = raw.split(':');
  const normalizedRouteId = routeId.trim();
  if (!normalizedRouteId) return '--delivery-route requires a route id.';
  return {
    kind: 'surface',
    routeId: normalizedRouteId,
    label: label?.trim() || undefined,
  };
}

export function parseWebhookDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const normalized = raw.trim();
  if (!normalized) return '--delivery-webhook requires a URL.';
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '--delivery-webhook must be an http(s) URL.';
  } catch {
    return '--delivery-webhook must be a valid URL.';
  }
  return {
    kind: 'webhook',
    address: normalized,
  };
}

export function parseLinkDeliveryTarget(raw: string): RoutineScheduleDeliveryTargetSpec | string {
  const normalized = raw.trim();
  if (!normalized) return '--delivery-link requires a URL or label.';
  return {
    kind: 'link',
    address: normalized,
  };
}

/**
 * The mixed-kind check, or null when the targets are usable.
 *
 * `commandNoun` names the command in the message ("reminder command",
 * "autonomous schedule command"). It is a parameter rather than a fixed string
 * because the wording is the only part that legitimately differs per command.
 */
export function validateDeliveryTargets(
  targets: readonly RoutineScheduleDeliveryTargetSpec[],
  commandNoun: string,
): string | null {
  const kinds = new Set(targets.map((target) => target.kind));
  return kinds.size > 1 ? `Use one delivery target kind per ${commandNoun}.` : null;
}

export function deliveryModeFromTargets(
  targets: readonly RoutineScheduleDeliveryTargetSpec[],
): RoutineScheduleDeliveryKind | 'none' {
  const first = targets[0];
  return first ? first.kind : 'none';
}

export function toDeliveryTargetInput(target: RoutineScheduleDeliveryTargetSpec): ScheduleDeliveryTargetInput {
  return {
    kind: target.kind,
    surfaceKind: target.surfaceKind as ScheduleDeliveryTargetInput['surfaceKind'],
    address: target.address,
    routeId: target.routeId,
    label: target.label,
  };
}

// ---------------------------------------------------------------------------
// Provider/model
// ---------------------------------------------------------------------------

/** Splits a `provider/model` value into its parts, inferring the provider when only a model is given. */
export function normalizeProviderModel(provider: string | undefined, model: string | undefined): {
  readonly provider?: string;
  readonly model?: string;
} {
  if (!model) return provider ? { provider } : {};
  const normalizedProvider = provider ?? getProviderIdFromModel(model);
  return {
    provider: normalizedProvider,
    model: getModelIdFromProviderModel(model),
  };
}
