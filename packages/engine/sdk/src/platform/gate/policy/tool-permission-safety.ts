/**
 * Shared permission lifetime guard. Agent bootstrap installs this implementation;
 * product adapters must not decide permissions when the authoritative gate fails.
 */
import type { PermissionCategory } from '../../permissions/types.js';
import type { PermissionManager } from '../../permissions/manager.js';
import { assertPermissionActive, awaitPermission } from '../../permissions/cancellation.js';
import { snapshotJudgmentInput } from '../judgment-input.js';
import { categoryForSideEffectKind, readSideEffectKind } from '../reading.js';

/** Default decision site for standalone category readings, never an approval. */
export const TOOL_PERMISSION_SAFETY_SITE = 'engine.gate.tool-permission-safety';

export type PermissionManagerLike = Pick<PermissionManager, 'check' | 'getCategory'>
  & Partial<Pick<PermissionManager, 'checkDetailed'>>;

const SAFETY_MARKER = Symbol.for('goodvibes-agent.permission-safety-installed');

type MarkedPermissionManager = PermissionManagerLike & { [SAFETY_MARKER]?: true };

/** A permission category read from the call by Jev, and whether the reading was confident. */
export interface PermissionCategoryReading {
  readonly category: PermissionCategory;
  readonly confident: boolean;
}

/** Reads a tool call's permission category: its side-effect kind, mapped to a category. */
export async function readPermissionCategory(
  toolName: string,
  args: Record<string, unknown>,
  site: string = TOOL_PERMISSION_SAFETY_SITE,
  signal?: AbortSignal,
): Promise<PermissionCategoryReading> {
  assertPermissionActive(signal);
  const snapshot = snapshotJudgmentInput(args, toolName) as Record<string, unknown>;
  const reading = await awaitPermission(() => readSideEffectKind(toolName, snapshot, site, signal), signal);
  return { category: categoryForSideEffectKind(reading.kind), confident: reading.confident };
}

/**
 * Preserve the one authoritative permission decision and its execution lifetime.
 * A side-effect category is not permission: it cannot replace a failed boundary,
 * revoked authority, unavailable judgment, or a manager's typed decision.
 *
 * Retry belongs to the shared judgment/gate executor (THE116), never this wrapper.
 * Until that executor supplies a decision, its pending promise or typed failure
 * propagates unchanged. No outage is converted into a local allow or deny.
 */
export function installPermissionManagerSafetyGuard(manager: PermissionManagerLike, _site: string = TOOL_PERMISSION_SAFETY_SITE): void {
  const marked = manager as MarkedPermissionManager;
  if (marked[SAFETY_MARKER]) return;
  marked[SAFETY_MARKER] = true;

  const originalCheck = manager.check.bind(manager);
  const originalCheckDetailed = manager.checkDetailed?.bind(manager);

  manager.check = async (...input: Parameters<PermissionManager['check']>) => {
    if (input[3]) input[3] = { ...input[3] };
    const signal = input[3]?.signal;
    assertPermissionActive(signal);
    return awaitPermission(() => originalCheck(...input), signal);
  };

  if (originalCheckDetailed) {
    manager.checkDetailed = async (...input: Parameters<PermissionManager['checkDetailed']>) => {
      if (input[3]) input[3] = { ...input[3] };
      const signal = input[3]?.signal;
      assertPermissionActive(signal);
      return awaitPermission(() => originalCheckDetailed(...input), signal);
    };
  }
}
