/**
 * Bridges `permissions.mode` config changes onto the runtime event bus as a
 * gate `PRESET_CHANGED` event, so surfaces can render a live preset pill
 * without polling. The setting keeps its old values; each one selects a gate
 * preset (gate/presets.ts). The mode is settable through the ordinary config
 * surface (`config.set` operator method / ConfigManager.set); this binding is
 * the runtime-event half.
 */

import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import { emitPresetChanged } from '../runtime/emitters/gate.js';
import { presetForMode } from '../gate/presets.js';

/**
 * Subscribe to `permissions.mode` config changes and emit `PRESET_CHANGED` on
 * each real transition. Returns an unsubscribe function.
 *
 * @param sessionId, session/runtime id stamped on the emitted event.
 */
export function bindPermissionModeChangeEvent(
  configManager: Pick<ConfigManager, 'subscribe'>,
  runtimeBus: RuntimeEventBus,
  sessionId: string,
): () => void {
  return configManager.subscribe('permissions.mode', (newValue, oldValue) => {
    if (newValue === oldValue) return;
    const ctx: EmitterContext = {
      sessionId,
      traceId: randomUUID(),
      source: 'gate-preset',
    };
    emitPresetChanged(runtimeBus, ctx, {
      mode: String(newValue),
      previousMode: String(oldValue),
      preset: presetForMode(String(newValue)).name,
      previousPreset: presetForMode(String(oldValue)).name,
    });
  });
}
