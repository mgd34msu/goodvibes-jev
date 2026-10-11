/** Bounded native identity substitution; all action content still crosses semantic privacy. */
import { ToolInputProjectionError, assertProjectionCurrent, captureProjectionArgs, captureProjectionStructure,
  projectionContext, projectionFunction, projectionProperty } from './input-projection.js';

function pathValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') throw new ToolInputProjectionError('binding-changed');
    const next = projectionProperty(current, key);
    if (!Object.hasOwn(current, key)) throw new ToolInputProjectionError('binding-changed');
    current = next;
  }
  return current;
}

function assertUnselected(original: unknown, projected: unknown, selected: ReadonlySet<string>, path: readonly string[] = []): void {
  if (selected.has(JSON.stringify(path))) {
    if (typeof original !== 'string' || typeof projected !== 'string') throw new ToolInputProjectionError('invalid');
    return;
  }
  if (!original || typeof original !== 'object' || !projected || typeof projected !== 'object') {
    if (JSON.stringify(original) !== JSON.stringify(projected)) throw new ToolInputProjectionError('binding-changed');
    return;
  }
  if (Array.isArray(original) !== Array.isArray(projected)
    || (Array.isArray(original) && original.length !== (projected as unknown[]).length)) throw new ToolInputProjectionError('binding-changed');
  const originalKeys = Object.keys(original);
  const projectedKeys = Object.keys(projected).filter(key => path.length !== 0 || key !== 'nativeReferenceSubjects');
  if (originalKeys.length !== projectedKeys.length) throw new ToolInputProjectionError('binding-changed');
  for (const key of originalKeys) {
    if (!Object.hasOwn(projected, key)) throw new ToolInputProjectionError('binding-changed');
    assertUnselected(projectionProperty(original, key), projectionProperty(projected, key), selected, [...path, key]);
  }
}

export function captureNativeReferenceProjection(value: object, original: Record<string, unknown>, name: string) {
  const fields = captureProjectionStructure({ fields: projectionProperty(value, 'fields') })['fields'];
  const nested = captureProjectionStructure({ paths: projectionProperty(value, 'paths') })['paths'];
  const args = captureProjectionStructure(projectionProperty(value, 'args'));
  const assertCurrent = projectionFunction<() => void>(projectionProperty(value, 'assertCurrent'));
  const executionContext = projectionContext(projectionProperty(value, 'executionContext'));
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')
    || (nested !== undefined && (!Array.isArray(nested) || nested.some(path => !Array.isArray(path)
      || !path.length || path.length > 64 || path.some(key => typeof key !== 'string' || !key.length))))
    || !assertCurrent
    || Object.hasOwn(original, 'nativeReferenceSubjects')) throw new ToolInputProjectionError('invalid');
  const paths: readonly (readonly string[])[] = [...fields.map(field => [field as string]), ...((nested ?? []) as readonly (readonly string[])[])];
  if (!paths.length || paths.length > 8 || paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex
    && path.length <= other.length && path.every((key, depth) => other[depth] === key)))) throw new ToolInputProjectionError('invalid');
  const subjects = args['nativeReferenceSubjects'];
  if (!Object.hasOwn(args, 'nativeReferenceSubjects') || !subjects || typeof subjects !== 'object'
    || !Object.keys(subjects).length) throw new ToolInputProjectionError('invalid');
  const selected = new Set(paths.map(path => JSON.stringify(path)));
  for (const path of paths) if (path[0] === 'nativeReferenceSubjects' || typeof pathValue(original, path) !== 'string'
    || typeof pathValue(args, path) !== 'string') throw new ToolInputProjectionError('invalid');
  assertUnselected(original, args, selected);
  assertProjectionCurrent(assertCurrent);
  const captured = captureProjectionArgs(args, name);
  assertProjectionCurrent(assertCurrent);
  const boundPaths = [...paths, ['nativeReferenceSubjects']];
  const assertArgs = (next: Record<string, unknown>) => {
    for (const path of boundPaths) if (JSON.stringify(pathValue(next, path)) !== JSON.stringify(pathValue(captured, path))) {
      throw new ToolInputProjectionError('binding-changed');
    }
  };
  const schemaArgs = (next: Record<string, unknown>): Record<string, unknown> => {
    assertArgs(next);
    // The retained native subject is admission evidence, outside the callable
    // schema. Every action field still uses the exact public schema unchanged.
    const callable = { ...next }; delete callable['nativeReferenceSubjects'];
    return Object.freeze(callable);
  };
  return { args: captured, assertCurrent, executionContext, assertArgs, schemaArgs };
}
