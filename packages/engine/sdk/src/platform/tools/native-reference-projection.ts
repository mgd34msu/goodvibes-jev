/** Bounded native identity substitution; all action content still crosses semantic privacy. */
import { ToolInputProjectionError, assertProjectionCurrent, captureProjectionArgs, captureProjectionStructure,
  projectionContext, projectionFunction, projectionProperty } from './input-projection.js';

export function captureNativeReferenceProjection(value: object, original: Record<string, unknown>, name: string) {
  const fields = captureProjectionStructure({ fields: projectionProperty(value, 'fields') })['fields'];
  const args = captureProjectionStructure(projectionProperty(value, 'args'));
  const assertCurrent = projectionFunction<() => void>(projectionProperty(value, 'assertCurrent'));
  const executionContext = projectionContext(projectionProperty(value, 'executionContext'));
  if (!Array.isArray(fields) || !fields.length || fields.length > 8 || !assertCurrent
    || fields.some(field => typeof field !== 'string') || new Set(fields).size !== fields.length
    || Object.hasOwn(original, 'nativeReferenceSubjects')) throw new ToolInputProjectionError('invalid');
  const subjects = args['nativeReferenceSubjects'];
  if (!Object.hasOwn(args, 'nativeReferenceSubjects') || !subjects || typeof subjects !== 'object'
    || !Object.keys(subjects).length) throw new ToolInputProjectionError('invalid');
  const selected = new Set<string>(fields);
  for (const field of selected) if (typeof original[field] !== 'string' || typeof args[field] !== 'string') throw new ToolInputProjectionError('invalid');
  for (const field of Object.keys(original)) if (!Object.hasOwn(args, field)
    || (!selected.has(field) && JSON.stringify(original[field]) !== JSON.stringify(args[field]))) throw new ToolInputProjectionError('binding-changed');
  if (Object.keys(args).some(field => !Object.hasOwn(original, field) && field !== 'nativeReferenceSubjects')) throw new ToolInputProjectionError('invalid');
  assertProjectionCurrent(assertCurrent);
  const captured = captureProjectionArgs(args, name);
  assertProjectionCurrent(assertCurrent);
  const boundFields = [...selected, 'nativeReferenceSubjects'];
  const assertArgs = (next: Record<string, unknown>) => {
    for (const field of boundFields) if (!Object.hasOwn(next, field)
      || JSON.stringify(next[field]) !== JSON.stringify(captured[field])) throw new ToolInputProjectionError('binding-changed');
  };
  return { args: captured, assertCurrent, executionContext, assertArgs };
}
