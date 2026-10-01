import type { ToolDefinition } from '../types/tools.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { paramFill, paramFillCandidate, paramFillContext } from './batteries/param-fill.js';
import { booleanValue, booleanValueView } from './batteries/boolean-value.js';

const PARAM_FILL_SITE = 'tools.auto-repair.param-fill';
const BOOLEAN_VALUE_SITE = 'tools.auto-repair.boolean-value';

/** Result of a tool call repair attempt. */
export interface RepairResult {
  repaired: boolean;
  original: Record<string, unknown>;
  fixed: Record<string, unknown>;
  /** Human-readable list of what was fixed. */
  repairs: string[];
  /** Repair failures callers can surface as warning metadata. */
  warnings?: string[] | undefined;
}

/**
 * Attempt to repair a malformed tool call by inferring missing/wrong params.
 *
 * Returns repaired arguments and a log of what was fixed.
 * If no repairs are needed (or repair is impossible), returns the original unchanged
 * with repaired=false.
 *
 * Design: the format repairs never throw; a failure there returns the
 * original arguments with a warning. Reading which boolean a non-literal
 * string means (`engine.tools.boolean-value`) and filling a missing required
 * parameter from a spare argument (`engine.tools.param-fill`) are readings,
 * and a JudgmentError from either propagates. Calls that are already correct
 * pass through unchanged, and a call with no such string and no missing
 * required string parameter asks nothing.
 *
 * The original execution signal also owns this caller's repair wait. A
 * cancelled reading cannot apply a late answer, even when a borrowed port
 * ignores cancellation. Abort reasons are never exposed as repair errors.
 */
export async function repairToolCall(
  toolName: string,
  args: Record<string, unknown>,
  schema: ToolDefinition,
  signal?: AbortSignal,
): Promise<RepairResult> {
  assertRepairActive(signal);
  let fixed: Record<string, unknown>;
  const repairs: string[] = [];
  const booleanStrings: Array<{ key: string; value: string }> = [];
  const params = schema.parameters as Record<string, unknown> | undefined;
  const declared = params?.properties;
  const properties = (declared !== null && typeof declared === 'object' ? declared : {}) as Record<string, Record<string, unknown>>;
  const required = (Array.isArray(params?.required) ? params.required : []).filter((key): key is string => typeof key === 'string');

  try {
    fixed = structuredClone(args);

    // --- Rule 1: Missing `mode` on agent tool ---
    if (toolName === 'agent' && fixed['mode'] === undefined) {
      const inferred = _inferAgentMode(fixed);
      if (inferred !== null) {
        fixed['mode'] = inferred;
        repairs.push(`inferred missing mode='${inferred}' for agent tool`);
      }
    }

    // --- Rule 3 & 4 & 5: Per-property coercions ---
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in fixed)) {
        // Property missing, handle in Rule 2 below
        continue;
      }

      const value = fixed[key]!;
      const expectedType = propSchema['type'] as string | undefined;
      const enumValues = propSchema['enum'] as unknown[] | undefined;

      // Rule 3: String → number coercion
      if (expectedType === 'number' && typeof value === 'string') {
        const coerced = Number(value);
        if (value.trim().length > 0 && !Number.isNaN(coerced)) {
          fixed[key] = coerced;
          repairs.push(`coerced ${key} from string '${value}' to number ${coerced}`);
        }
        continue;
      }

      // Rule 4: Boolean coercion. The JSON grammar spells the booleans `true`
      // and `false`, so a string holding exactly one is that boolean; any other
      // string is read by `engine.tools.boolean-value` after the format repairs.
      if (expectedType === 'boolean' && typeof value === 'string') {
        if (value === 'true' || value === 'false') {
          fixed[key] = value === 'true';
          repairs.push(`coerced ${key} from '${value}' to boolean ${value}`);
        } else {
          booleanStrings.push({ key, value });
        }
        continue;
      }

      // Rule 5: Enum normalization (case-insensitive match)
      if (enumValues && typeof value === 'string') {
        const exactMatch = enumValues.includes(value);
        if (!exactMatch) {
          const lower = value.toLowerCase();
          const normalized = enumValues.find(
            (e) => typeof e === 'string' && e.toLowerCase() === lower,
          );
          if (normalized !== undefined) {
            fixed[key] = normalized;
            repairs.push(`normalized ${key} from '${value}' to enum value '${normalized}'`);
          }
        }
      }
    }

  } catch (err) {
    // Cancellation is not a format failure and must not become a warning.
    assertRepairActive(signal);
    // Never let repair logic crash the caller
    const warning = `Auto-repair skipped for tool '${toolName}': ${summarizeError(err)}`;
    logger.warn('repairToolCall: unexpected error produced warning result', {
      toolName,
      error: summarizeError(err),
    });
    return { repaired: false, original: args, fixed: args, repairs: [], warnings: [warning] };
  }

  // --- Rule 4, read: which boolean, if any, a non-literal string means ---
  for (const { key, value } of booleanStrings) {
    const description = properties[key]?.['description'];
    const run = await booleanValue.run(
      repairPort(BOOLEAN_VALUE_SITE, signal),
      booleanValueView(toolName, key, typeof description === 'string' ? description : undefined, value),
      { site: BOOLEAN_VALUE_SITE, ...(signal === undefined ? {} : { signal }) },
    );
    assertRepairActive(signal);
    const reading = run.readings.boolean_value;
    const meant = reading.outcome === 'act' && reading.choice !== 'neither' ? reading.choice === 'true' : undefined;
    run.recordAction(meant === undefined ? `left ${key} as sent` : `coerced ${key} to ${meant}`);
    assertRepairActive(signal);
    if (meant !== undefined) {
      fixed[key] = meant;
      repairs.push(`coerced ${key} from '${value}' to boolean ${meant}`);
    }
  }

  // --- Rule 2: Missing required string params, filled from a spare argument Jev picks ---
  for (const requiredKey of required) {
    if (requiredKey in fixed) continue;
    const targetSchema = properties[requiredKey];
    if (targetSchema?.['type'] !== 'string') continue; // only string params
    const candidate = await _pickStringCandidate(toolName, schema, requiredKey, fixed, properties, required, signal);
    assertRepairActive(signal);
    if (candidate !== null) {
      fixed[requiredKey] = candidate.value;
      delete fixed[candidate.sourceKey];
      repairs.push(
        `filled missing required param '${requiredKey}' from non-required param '${candidate.sourceKey}'`,
      );
    }
  }

  assertRepairActive(signal);
  const repaired = repairs.length > 0;

  if (repaired) {
    logger.debug('repairToolCall: repaired malformed tool call', {
      toolName,
      repairs,
    });
  }

  return { repaired, original: args, fixed, repairs };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function assertRepairActive(signal?: AbortSignal): void {
  // A caller's arbitrary abort reason can contain private context. Keep the
  // judgment protocol's typed cancellation without retaining that reason.
  if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
}

/**
 * Interrupt the ask, before the battery can attach readings or apply an
 * answer. The existing wait helper drains late rejections and removes this
 * caller's listener; it never cancels another caller's reading.
 */
function repairPort(site: string, signal?: AbortSignal): JudgmentPort {
  assertRepairActive(signal);
  const port = judgmentPort(site);
  if (!signal) return port;
  const recorder = port.recorder;
  return {
    get model() { return port.model; },
    ...(recorder === undefined ? {} : { recorder: {
      recordReadings(id, readings) { assertRepairActive(signal); recorder.recordReadings(id, readings); },
      recordAction(id, action) { assertRepairActive(signal); recorder.recordAction(id, action); },
    } satisfies JudgmentPort['recorder'] }),
    ...(port.health === undefined ? {} : { health: () => port.health!() }),
    async ask(request) {
      try {
        const result = await executePolicyCheck(() => port.ask(request), signal);
        assertRepairActive(signal);
        return result;
      } catch (error) {
        assertRepairActive(signal);
        throw error;
      }
    },
  };
}

/**
 * Rule 1: the agent tool's `mode`, when the arguments settle it. `task` and
 * `template` are fields of spawn mode only (agent/schema.ts), so a call that
 * carries either is a spawn. Nothing else settles it: `agentId` belongs to
 * seven modes (status, cancel, get, budget, plan, wait, message) and an empty
 * call names none, so those calls are left without a mode and fail on it.
 */
function _inferAgentMode(args: Record<string, unknown>): string | null {
  const hasTask = typeof args['task'] === 'string' && args['task'].length > 0;
  const hasTemplate = typeof args['template'] === 'string';
  return hasTask || hasTemplate ? 'spawn' : null;
}

/**
 * Rule 2: which spare argument, if any, holds the value meant for the missing
 * required string parameter `targetKey`. Code offers the spare arguments that
 * could type-check as it (present, non-empty strings the schema does not
 * require and types as a string or does not declare); the
 * `engine.tools.param-fill` selection picks one or none. Only a pick that
 * acts fills the parameter; anything else leaves it missing, so the call
 * fails on it as it would have without repair.
 */
async function _pickStringCandidate(
  toolName: string,
  schema: ToolDefinition,
  targetKey: string,
  args: Record<string, unknown>,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
  signal?: AbortSignal,
): Promise<{ sourceKey: string; value: string } | null> {
  const spare = Object.entries(args).filter(([key, value]) => {
    if (required.includes(key)) return false;
    if (typeof value !== 'string' || value.length === 0) return false;
    const propType = properties[key]?.['type'];
    return propType === 'string' || propType === undefined;
  }) as [string, string][];
  if (spare.length === 0) return null;

  const describe = (key: string): string | undefined => {
    const description = properties[key]?.['description'];
    return typeof description === 'string' ? description : undefined;
  };
  const selection = await paramFill.select(
    repairPort(PARAM_FILL_SITE, signal),
    paramFillContext(toolName, schema.description, targetKey, describe(targetKey)),
    spare.map(([key, value]) => paramFillCandidate(key, value, describe(key))),
    { site: PARAM_FILL_SITE, ...(signal === undefined ? {} : { signal }) },
  );
  assertRepairActive(signal);
  const filled = selection.chosen !== undefined && selection.outcome === 'act';
  selection.recordAction(filled ? `filled ${targetKey} from ${selection.chosen}` : `left ${targetKey} missing`);
  assertRepairActive(signal);
  if (!filled) return null;
  const picked = spare.find(([key]) => key === selection.chosen);
  return picked ? { sourceKey: picked[0], value: picked[1] } : null;
}
