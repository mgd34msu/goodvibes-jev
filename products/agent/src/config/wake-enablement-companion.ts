/**
 * wake-enablement-companion.ts, the second row that has to move when wake
 * detection is turned on.
 *
 * `voice.wake.enabled` and `voice.wake.surfaces.<surface>` BOTH gate one
 * feature, and only one of them is the switch anybody looks for. Turning the
 * feature on while this surface's row is off stores the value correctly,
 * reports success, and opens no microphone, a setting that configures
 * nothing. That cost the owner an entire session: he enabled wake detection,
 * was told it was enabled, and nothing ever listened.
 *
 * So the write takes its companion with it, and says so. The rule itself is the
 * SDK's (platform/voice/wake/settings.ts) so every surface applies the same
 * one; what lives here is this product's surface identity and its config
 * writer.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveWakeEnablementCompanion } from '@goodvibes-jev/engine/sdk/platform/voice';
import { AGENT_WAKE_SURFACE } from '../audio/wake-surface.ts';
import { routeConfigWrite, type AgentConfigRoutingOptions } from './daemon-config-routing.ts';

/** What was also set, for the reply. */
export interface WakeCompanionWrite {
  readonly key: string;
  readonly value: unknown;
  /** Plain words: what the companion row was, and what leaving it would have done. */
  readonly message: string;
}

/**
 * Apply the companion write for `key`, if one is owed. Returns null when the
 * key is not `voice.wake.enabled`, when it is being turned off, or when this
 * surface is already opted in.
 */
export async function applyWakeEnablementCompanion(
  configManager: ConfigManager,
  key: string,
  value: unknown,
  routing: AgentConfigRoutingOptions = {},
): Promise<WakeCompanionWrite | null> {
  const companion = resolveWakeEnablementCompanion(
    key,
    value,
    (companionKey: string) => configManager.get(companionKey as ConfigKey),
    AGENT_WAKE_SURFACE,
  );
  if (!companion) return null;
  await routeConfigWrite(configManager, companion.key, companion.value, {
    homeDir: configManager.getHomeDirectory() ?? undefined,
    ...routing,
  });
  return { key: companion.key, value: companion.value, message: companion.message };
}
