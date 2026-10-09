/**
 * Immutable legacy POST /config implementation from actual main
 * 59959220b1e6b460d4cadec8d0f732aac42d6f47 (after PR201, before SETTINGS).
 * system-routes.ts blob: 1e3abfb6f91eeaa403ed91864d325f5c4d8d9694.
 * The three marked regions are byte-exact extractions; only the factory
 * wrapper and imports are supplied here. error-response.ts is unchanged
 * (blob 94ae3f581a8e373851ce9ecb2996618309b86c23).
 */
import type { DaemonSystemRouteContext } from '../../../daemon-sdk/src/system-route-types.js';
import type { DaemonSystemRouteHandlers } from '../../../daemon-sdk/src/context.js';
import { jsonErrorResponse, readJsonErrorResponse } from '../../../daemon-sdk/src/error-response.js';

export function createLegacyPostConfigHandler(context: DaemonSystemRouteContext): DaemonSystemRouteHandlers['postConfig'] {
  return async (req) => {
// BEGIN pinned postConfig
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      // Body parsing may outlive the authority checked on entry. Reacquire it
      // before either settings mutation or the workspace-dispatch branch.
      const currentAdmin = context.requireAdmin(req);
      if (currentAdmin) return currentAdmin;
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (key === 'runtime.workingDir') {
        return handleWorkingDirectoryConfig(context, key, value);
      }
      if (!context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: 'Invalid config key' }, { status: 400 });
      }
      try {
        context.configManager.setDynamic(key, value);
      } catch (error: unknown) {
        return readJsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to set config' });
      }
      // Report what the host now HOLDS, not what the caller asked for.
      //
      // Echoing the request back made this route say "success" for any write,
      // it could not distinguish a value that took from one that was coerced,
      // dropped, or overridden. It also never named the store, and the store is
      // the whole question here: an agent writes over the control plane into the
      // DAEMON's surface-scoped settings file, then reads the same key back from
      // its OWN settings file and sees the old value. Both are correct; nothing
      // said they were different files.
      const current = context.configManager.get(key);
      const source = context.configManager.describeConfigKeySource?.(key);
      // A daemon-owned key does NOT live in the host's surface settings file,
      // it lives in the daemon's own store. Reporting the surface path for it
      // would name the wrong file, which is the confusion this replaces.
      const persistedTo = (source?.daemonOwned ? source.daemonTierPath : null)
        ?? context.configManager.getConfigPath?.();
      if (!configValuesMatch(current, value)) {
        return jsonErrorResponse(
          {
            error: `Config key ${key} did not take the requested value`
              + `${persistedTo ? ` in ${persistedTo}` : ''}. The host now reports ${JSON.stringify(current)}.`,
            code: 'CONFIG_SET_NOT_APPLIED',
          },
          { status: 409 },
        );
      }
      // Name the OWNER as well as the file. "Saved" is only meaningful once a
      // caller knows whether the value landed where the runtime that acts on it
      // will read it, the whole point of daemon-owned config scope.
      return Response.json({
        success: true,
        key,
        value: current,
        ...(persistedTo ? { persistedTo } : {}),
        ...(source ? { tier: source.tier, daemonOwned: source.daemonOwned } : {}),
      });
// END pinned postConfig
  };
}

// BEGIN pinned workingDirectory
async function handleWorkingDirectoryConfig(
  context: DaemonSystemRouteContext,
  key: string,
  value: unknown,
): Promise<Response> {
  if (!context.swapManager) {
    return jsonErrorResponse({ error: 'Workspace swapping is not available in this daemon configuration.' }, { status: 400 });
  }
  if (typeof value !== 'string' || !value.trim()) {
    return jsonErrorResponse({ error: 'runtime.workingDir value must be a non-empty string path.', code: 'INVALID_PATH' }, { status: 400 });
  }
  const result = await context.swapManager.requestSwap(value);
  if (result.ok) {
    return Response.json({ success: true, key, value: result.current, previous: result.previous });
  }
  return jsonErrorResponse(
    {
      error: result.reason,
      code: result.code,
      ...(result.code === 'WORKSPACE_BUSY' ? { retryAfter: result.retryAfter } : {}),
    },
    { status: result.code === 'WORKSPACE_BUSY' ? 409 : 400 },
  );
}
// END pinned workingDirectory

// BEGIN pinned configValuesMatch
function configValuesMatch(current: unknown, requested: unknown): boolean {
  if (Object.is(current, requested)) return true;
  try {
    return JSON.stringify(current) === JSON.stringify(requested);
  } catch {
    return false;
  }
}
// END pinned configValuesMatch
