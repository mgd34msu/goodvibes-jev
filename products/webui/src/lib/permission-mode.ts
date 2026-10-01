/**
 * permission-mode.ts, the session-scoped operator permission-mode vocabulary.
 *
 * GROUNDED: `sessions.permissionMode.get`/`.set` (SDK 1.6.1, routes/session-runtime.ts)
 * are real session-scoped operator verbs, the daemon answers only for the session id
 * that IS its own live local runtime; any other session id is an honest 404
 * SESSION_NOT_LOCAL (lib/errors.ts's isSessionNotLocalError). This replaces the earlier
 * daemon-wide workaround that read/wrote the shared `permissions.mode` config key via
 * config.get/config.set, that path is gone; see git history for the prior version of
 * this module if the config-vocabulary mapping is ever needed again.
 *
 * VOCABULARY: the wire's operator-facing mode strings are already the plain-language
 * ones ('plan' | 'normal' | 'accept-edits' | 'auto' | 'custom'), cross-checked against
 * the installed @goodvibes-jev/engine/contracts operator-contract.json's
 * `sessions.permissionMode.get`/`.set` outputSchema/inputSchema enums. 'custom' is
 * READ-ONLY: it means the session is running a bespoke rule set, and
 * `sessions.permissionMode.set`'s inputSchema enum deliberately excludes it as a
 * settable value, SETTABLE_PERMISSION_MODES mirrors that split so the picker never
 * offers it as a choice.
 */

export const PERMISSION_MODES = ['plan', 'normal', 'accept-edits', 'auto', 'custom'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The subset `sessions.permissionMode.set` actually accepts, 'custom' is read-only. */
export const SETTABLE_PERMISSION_MODES = ['plan', 'normal', 'accept-edits', 'auto'] as const;
export type SettablePermissionMode = (typeof SETTABLE_PERMISSION_MODES)[number];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isSettablePermissionMode(value: string): value is SettablePermissionMode {
  return (SETTABLE_PERMISSION_MODES as readonly string[]).includes(value);
}

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'Plan',
  normal: 'Normal',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  custom: 'Custom',
};

export function permissionModeLabel(mode: string): string {
  return isPermissionMode(mode) ? PERMISSION_MODE_LABELS[mode] : (mode || 'Unknown');
}
