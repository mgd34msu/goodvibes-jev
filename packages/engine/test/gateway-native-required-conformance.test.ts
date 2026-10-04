/**
 * Authenticated counterpart to gateway-verb-required-conformance.test.ts.
 * The generic probe uses a user principal and cannot reach native validation:
 * all three native families require live paired-token authority first. Here
 * every registered native handler must reach its host using ONLY descriptor-
 * required input, and every required field must be rejected when omitted.
 * Host-entry sentinels prevent a 403/503 before validation from passing green.
 * Real authority creation and transport enforcement remain covered by
 * pairing-native-authority and work-ledger-native-{execution,intake-routes}.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog, type GatewayMethodInvocation } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerNativeConversationIntakeGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-intake.js';
import { registerNativeWorkSubmissionGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-work-submission.js';
import { registerNativeWorkExecutionGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-work-execution.js';
import type { NativePairedSnapshot } from '../sdk/src/platform/security/http-auth.js';

const revision = { work: 1, criteria: 1, attempt: 1 };
const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ['workLedger.intake.capture', { requestId: 'request', inputId: 'input', text: 'Exact source', unsupportedSources: [] }, 'NATIVE_INTAKE_UNAVAILABLE'],
  ['workLedger.intake.get', { inputId: 'input' }, 'NATIVE_INTAKE_UNAVAILABLE'],
  ...['admit', 'resume', 'cancel'].map(operation => [
    `workLedger.intake.${operation}`, { inputId: 'input', sourceRevision: 'revision' }, 'NATIVE_INTAKE_UNAVAILABLE',
  ] as const),
  ['workLedger.submit', { requestId: 'request', inputId: 'input', expectedRevision: 1, goal: 'Exact goal', criteria: ['Exact criterion'] }, 'NATIVE_SUBMISSION_UNAVAILABLE'],
  ['workLedger.submission.get', { requestId: 'request' }, 'NATIVE_SUBMISSION_UNAVAILABLE'],
  ...['start', 'status', 'cancel', 'resume'].map(operation => [
    `workLedger.execution.${operation}`, { projectId: 'project', workId: 'work', attemptId: 'attempt', expectedRevision: revision }, 'NATIVE_EXECUTION_UNAVAILABLE',
  ] as const),
];

function fixture() {
  const catalog = new GatewayMethodCatalog();
  const calls: string[] = [];
  const reached = async (operation: string): Promise<never> => {
    calls.push(operation);
    throw new Error('Native required-input probe reached the host');
  };
  registerNativeConversationIntakeGatewayMethods(catalog, {
    capture: () => reached('workLedger.intake.capture'), get: () => reached('workLedger.intake.get'),
    admit: () => reached('workLedger.intake.admit'), resume: () => reached('workLedger.intake.resume'),
    cancel: () => reached('workLedger.intake.cancel'),
  });
  registerNativeWorkSubmissionGatewayMethods(catalog, {
    submit: () => reached('workLedger.submit'), get: () => reached('workLedger.submission.get'),
  });
  registerNativeWorkExecutionGatewayMethods(catalog, { projectId: 'project', acquire: () => reached('execution-host') });
  const scopes = ['read:work-ledger', 'write:work-ledger', 'write:fleet'];
  const current: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'probe-token', principalId: 'pairing:probe-token',
    authorityId: 'pairing:probe-token', authorityRevision: 'probe-token', scopes };
  const invocation = (body: unknown): GatewayMethodInvocation => ({
    body, context: { admin: true, principalKind: 'token', principalId: current.principalId, scopes },
    isAuthorized: () => true,
    nativeExecutionAuthority: { current: () => current, withCurrent: async (_expected, operation) => operation(() => current) },
  });
  return { catalog, calls, invocation };
}

interface RequiredSchema {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, RequiredSchema>>;
}

/** Recursively omit even nested optional fields; no sample can hide a gap. */
function requiredOnly(schema: RequiredSchema, sample: unknown): unknown {
  if (schema.type !== 'object') return sample;
  const values = sample as Record<string, unknown>;
  return Object.fromEntries((schema.required ?? []).map(field => [field,
    requiredOnly(schema.properties?.[field] ?? {}, values[field]),
  ]));
}

function requiredPaths(schema: RequiredSchema, prefix: readonly string[] = []): readonly (readonly string[])[] {
  return (schema.required ?? []).flatMap(field => {
    const path = [...prefix, field];
    return [path, ...requiredPaths(schema.properties?.[field] ?? {}, path)];
  });
}

function omitPath(body: unknown, path: readonly string[]): unknown {
  const copy = structuredClone(body) as Record<string, unknown>;
  let cursor = copy;
  for (const field of path.slice(0, -1)) cursor = cursor[field] as Record<string, unknown>;
  delete cursor[path[path.length - 1]!];
  return copy;
}

describe('native gateway required-field conformance under paired authority', () => {
  test('every native handler is covered by an authenticated probe', () => {
    const { catalog } = fixture();
    const registered = catalog.list().filter(descriptor => catalog.hasHandler(descriptor.id)).map(descriptor => descriptor.id).sort();
    expect(registered).toEqual(cases.map(([id]) => id).sort());
    expect(registered).toHaveLength(11);
  });

  for (const [id, sample, unavailableCode] of cases) {
    test(`${id} reaches its host with required-only input and rejects each missing requirement before host entry`, async () => {
      const f = fixture();
      const descriptor = f.catalog.get(id)!;
      const schema = descriptor.inputSchema as RequiredSchema;
      expect(schema.type).toBe('object');
      const body = requiredOnly(schema, sample);
      await expect(f.catalog.invoke(id, f.invocation(body))).rejects.toMatchObject({ status: 503, code: unavailableCode });
      expect(f.calls).toEqual([id.startsWith('workLedger.execution.') ? 'execution-host' : id]);
      f.calls.length = 0;
      const paths = requiredPaths(schema);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        await expect(f.catalog.invoke(id, f.invocation(omitPath(body, path)))).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
        expect(f.calls).toEqual([]);
      }
      // Auth must still run before host entry, including when input is valid.
      const invocation = f.invocation(body);
      await expect(f.catalog.invoke(id, { ...invocation, nativeExecutionAuthority: undefined })).rejects.toMatchObject({ status: 403 });
      await expect(f.catalog.invoke(id, { ...invocation, isAuthorized: () => false })).rejects.toMatchObject({ status: 403 });
      expect(f.calls).toEqual([]);
    });
  }
});
