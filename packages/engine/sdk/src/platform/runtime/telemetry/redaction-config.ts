/**
 * Telemetry prompt/response redaction configuration.
 *
 * Privacy model (what actually ships):
 *
 * - RuntimeEventBus carries raw prompt/response strings. In-process
 *   consumers (conversation reducer, channel reply pipeline, stream UI)
 *   require raw content to render and advance state.
 *
 * - TelemetryApiService ring buffer stores raw payloads.
 *
 * - Egress boundary: `listEvents({view: 'safe'})` (the default) runs records
 *   through `sanitizeRecord` → `redactStructuredData` (see
 *   `utils/redaction.ts`). The canonical structured redactor masks content,
 *   secrets, and fields without a settled safe reading. Record messages,
 *   error display text, and span display text use the same redactor.
 *
 * - Raw reads require the serving TelemetryApiService's live
 *   `telemetry.includeRawPrompts` opt-in. The HTTP boundary additionally
 *   requires `admin` or `read:telemetry-sensitive`, plus `read:telemetry`.
 *   Disabled raw reads fail with TELEMETRY_RAW_DISABLED; they never fall back
 *   to safe data labeled as raw. Raw SSE streams recheck the opt-in before
 *   every event and heartbeat and terminate when it is revoked.
 *
 * This module records the bootstrap setting and emits the opt-in warning.
 * DaemonHttpRouter gives each service a getter for its own config manager;
 * this bootstrap value grants no access to another daemon's telemetry.
 * A service constructed without an owning config getter disables raw reads.
 */
import { logger } from '../../utils/logger.js';

/** Bootstrap reporting only; raw-read authorization belongs to each service. */
let _includeRawPrompts = false;

/**
 * Record telemetry configuration. Called once at daemon bootstrap from
 * config.telemetry.includeRawPrompts. When true, a WARN log is emitted so ops
 * can see the opt-in is active.
 */
export function setTelemetryIncludeRawPrompts(value: boolean): void {
  _includeRawPrompts = value;
  if (value) {
    logger.warn(
      'telemetry.includeRawPrompts is ENABLED, authorized raw telemetry reads may expose prompt/response content. '
      + 'This setting is for debugging only. Disable in production to avoid PII/secret exfiltration.'
    );
  }
}

/** Read the recorded bootstrap setting; this is not a raw-read authorization. */
export function getTelemetryIncludeRawPrompts(): boolean {
  return _includeRawPrompts;
}
