/**
 * Tool permission safety: what a permission check answers when the permission
 * manager itself throws.
 *
 * Hoisted from the agent (src/runtime/tool-permission-safety.ts) into the
 * engine gate. The agent answered from about twenty hand-kept tables of tool
 * names and action strings (fallbackPermissionCategory /
 * fallbackPermissionCategoryForArgs). That classification is now Jev's
 * reading of the call: the side-effect battery's `kind` question
 * (`readSideEffectKind`, asked at the `engine.gate.tool-permission-safety`
 * site), mapped to a permission category by `categoryForSideEffectKind`. No
 * table remains behind it.
 *
 * The composition, in code: a call whose check threw is approved only when
 * Jev confidently reads it as a read; anything else, including a read Jev is
 * unsure of, is refused. A failed reading is not approval either: the error
 * reaches the caller.
 *
 * The manager's own category lookup (`getCategory`) is not wrapped. It is
 * synchronous and cannot wait on a reading, and the engine's permission
 * manager already reads the kind of any tool its closed tool table does not
 * name before it decides (permissions/manager.ts, step 4), which is what the
 * agent's category override supplied.
 */
import type { PermissionCategory, PermissionCheckResult } from '../../permissions/types.js';
import { summarizeError } from '../../utils/error-display.js';
import { categoryForSideEffectKind, readSideEffectKind } from '../reading.js';

/** The decision site the fallback readings are logged under. */
export const TOOL_PERMISSION_SAFETY_SITE = 'engine.gate.tool-permission-safety';

export type PermissionManagerLike = {
  check(toolName: string, args: Record<string, unknown>): Promise<boolean>;
  checkDetailed?: (toolName: string, args: Record<string, unknown>) => Promise<PermissionCheckResult>;
  getCategory(toolName: string, args?: Record<string, unknown>): PermissionCategory;
};

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
): Promise<PermissionCategoryReading> {
  const reading = await readSideEffectKind(toolName, args, site);
  return { category: categoryForSideEffectKind(reading.kind), confident: reading.confident };
}

/** Approve only a confident read; doubt never approves. */
const approvesAsRead = (reading: PermissionCategoryReading): boolean => reading.category === 'read' && reading.confident;

export function installPermissionManagerSafetyGuard(manager: PermissionManagerLike, site: string = TOOL_PERMISSION_SAFETY_SITE): void {
  const marked = manager as MarkedPermissionManager;
  if (marked[SAFETY_MARKER]) return;
  marked[SAFETY_MARKER] = true;

  const originalCheck = manager.check.bind(manager);
  const originalCheckDetailed = manager.checkDetailed?.bind(manager);

  manager.check = async (toolName, args) => {
    try {
      return await originalCheck(toolName, args);
    } catch {
      return approvesAsRead(await readPermissionCategory(toolName, args, site));
    }
  };

  if (originalCheckDetailed) {
    manager.checkDetailed = async (toolName, args) => {
      try {
        return await originalCheckDetailed(toolName, args);
      } catch (error) {
        const approved = approvesAsRead(await readPermissionCategory(toolName, args, site));
        return {
          approved,
          persisted: false,
          sourceLayer: 'runtime_mode',
          reasonCode: approved ? 'config_allow' : 'config_deny',
          analysis: {
            classification: 'generic',
            riskLevel: approved ? 'low' : 'high',
            summary: `Permission fallback for ${toolName}: ${summarizeError(error)}`,
            reasons: ['permission-manager-exception'],
          },
        };
      }
    };
  }
}
