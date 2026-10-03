import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { EFFORT_DESCRIPTIONS } from '@goodvibes-jev/engine/sdk/platform/providers';
import { effortPresentationForModel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { PickerItem } from './model-picker-types.ts';

/**
 * The effort levels a chosen model actually offers, plus a description for
 * each, used by `ModelPickerModal.showEffortPicker`.
 *
 * Resolving through the reasoning-effort surface (rather than reading
 * `model.reasoningEffort` as a bare list) is what keeps the picker from
 * offering `instant` to models that reject it, or hiding `xhigh`/`max`/`none`
 * from models that accept them.
 */
export function resolveEffortPickerState(model: ModelDefinition): {
  readonly levels: string[];
  readonly details: ReadonlyMap<string, string>;
} {
  const presentation = effortPresentationForModel(toEffortModel(model));
  const levels = presentation.choices.map((choice) => choice.level);
  const details = new Map(presentation.choices.map((choice) => [choice.level, choice.description]));
  return { levels, details };
}

/**
 * Effort levels as picker items, using the per-model descriptions resolved
 * above. Falls back to the shared level-description table for a level not
 * covered by `details`, a caller that set `effortLevels` directly, without
 * going through `resolveEffortPickerState`.
 */
export function buildEffortPickerItems(effortLevels: readonly string[], details: ReadonlyMap<string, string>): PickerItem[] {
  return effortLevels.map((level) => ({
    id: level,
    label: level,
    detail: details.get(level) ?? EFFORT_DESCRIPTIONS[level as keyof typeof EFFORT_DESCRIPTIONS] ?? '',
  }));
}
