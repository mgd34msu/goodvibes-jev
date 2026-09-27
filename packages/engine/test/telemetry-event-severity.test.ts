/**
 * Telemetry severity is a lookup over the fixed event type names the runtime
 * event domains declare. The table must list exactly the declared names: the
 * `Record` type makes a missing or extra key a compile error, and this test
 * holds the same line without depending on a typecheck run, by reading the
 * `AnyRuntimeEvent` union with the TypeScript compiler.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import { EVENT_SEVERITY } from '../sdk/src/platform/runtime/telemetry/event-severity.ts';
import { inferSeverity, isErrorEventType } from '../sdk/src/platform/runtime/telemetry/api-helpers.ts';
import type { NormalizedError } from '../sdk/src/platform/utils/error-display.ts';

/** Every string literal in the `type` field of the `AnyRuntimeEvent` union. */
function declaredEventTypes(): readonly string[] {
  const file = join(import.meta.dir, '..', 'sdk/src/events/domain-map.ts');
  const program = ts.createProgram([file], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const alias = source?.statements.find(
    (statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AnyRuntimeEvent',
  );
  if (alias === undefined) throw new Error('AnyRuntimeEvent is not declared in events/domain-map.ts');
  const union = checker.getTypeAtLocation(alias.name);
  const names = new Set<string>();
  for (const member of union.isUnion() ? union.types : [union]) {
    const property = member.getProperty('type');
    if (property === undefined) throw new Error(`an AnyRuntimeEvent member has no type field: ${checker.typeToString(member)}`);
    const typeOf = checker.getTypeOfSymbolAtLocation(property, alias);
    for (const part of typeOf.isUnion() ? typeOf.types : [typeOf]) {
      if (!part.isStringLiteral()) throw new Error(`an event type is not a string literal: ${checker.typeToString(part)}`);
      names.add(part.value);
    }
  }
  return [...names].sort();
}

describe('the event severity table', () => {
  test('lists exactly the event types the domains declare', () => {
    const declared = declaredEventTypes();
    expect(declared.length).toBeGreaterThan(200);
    expect(Object.keys(EVENT_SEVERITY).sort()).toEqual([...declared]);
  });
});

describe('severity and error-ness by name', () => {
  const error = { category: 'unknown', message: 'boom' } as unknown as NormalizedError;

  test('failures are errors', () => {
    for (const type of ['TURN_ERROR', 'TOOL_FAILED', 'TRANSPORT_TERMINAL_FAILURE', 'PREFLIGHT_FAIL', 'DELIVERY_DEAD_LETTERED', 'CONTRACT_FAILED']) {
      expect({ type, error: isErrorEventType(type), severity: inferSeverity(type) }).toEqual({ type, error: true, severity: 'error' });
    }
  });

  test('degraded, blocked, refused and over-budget states warn', () => {
    for (const type of ['MCP_DEGRADED', 'TASK_BLOCKED', 'CONTROL_PLANE_AUTH_REJECTED', 'WORKSPACE_SWAP_REFUSED', 'BUDGET_EXCEEDED_TOKENS', 'CONTRACT_STALLED']) {
      expect({ type, error: isErrorEventType(type), severity: inferSeverity(type) }).toEqual({ type, error: false, severity: 'warn' });
    }
  });

  test('in-flight progress and stream traffic is debug', () => {
    for (const type of ['STREAM_DELTA', 'AGENT_PROGRESS', 'TOOL_EXECUTING', 'MCP_RECONNECTING', 'WATCHER_HEARTBEAT', 'SESSION_STARTED']) {
      expect({ type, severity: inferSeverity(type) }).toEqual({ type, severity: 'debug' });
    }
  });

  test('completions and ordinary changes are info', () => {
    for (const type of ['TOOL_SUCCEEDED', 'TURN_COMPLETED', 'CONTRACT_PASSED', 'CONFIG_KEY_CHANGED']) {
      expect({ type, error: isErrorEventType(type), severity: inferSeverity(type) }).toEqual({ type, error: false, severity: 'info' });
    }
  });

  test('an attached normalized error makes any event an error', () => {
    expect(inferSeverity('TOOL_SUCCEEDED', error)).toBe('error');
  });

  test('a name no domain declares is info and not an error', () => {
    expect(inferSeverity('SOMETHING_FAILED_ELSEWHERE')).toBe('info');
    expect(isErrorEventType('SOMETHING_FAILED_ELSEWHERE')).toBe(false);
    expect(inferSeverity('toString')).toBe('info');
    expect(isErrorEventType('constructor')).toBe(false);
  });
});
