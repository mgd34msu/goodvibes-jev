/**
 * assert-contract-shape.ts, binds the e2e fixtures (seed.ts / mock-daemon.ts)
 * to the SDK's generated operator-contract.json, the SAME artifact
 * src/lib/goodvibes.test.ts's `bridge-matches-schema` suite (L354, assertConforms)
 * walks. The e2e harness is hermetic by design (never hits a port, see
 * mock-daemon.ts's header) and models real wire shapes, but nothing PINNED the
 * fixtures to the SDK contract, so a method rename or a reshaped envelope on the real
 * contract still passed the e2e mock green (the provider-pills incident: seed.ts's
 * providers.list fixture once invented a top-level `authenticated`/`freshnessSeconds`
 * the wire never sends, see providersResponse()'s header in seed.ts). This module
 * closes that gap for the response shapes the e2e mock hands back.
 *
 * DESIGN, deliberately a lightweight per-method OUTPUT shape check, not a full JSON
 * Schema validator (see the brief's risk note: right-size to how often the contract
 * moves). It mirrors assertConforms's exact walk and its exact intentional gaps:
 *   - Only descends into `properties` (objects) and `items` (arrays); an `anyOf` node
 *     (e.g. a nullable field) is treated as an opaque primitive, its OWN presence is
 *     checked by the parent's `required` list, but not walked further. Same trade-off
 *     assertConforms makes, for the same reason: many `anyOf` nodes in this contract
 *     don't reduce to a single structurally-checkable shape.
 *   - Enum values and primitive TYPES are not checked, only field PRESENCE, a schema
 *     rename (dropped/renamed required field) or a newly-required field are what this
 *     catches; a value going from `string` to `number` on an existing field is not.
 *   - additionalProperties:false nodes reject an invented field; additionalProperties
 *     left permissive (true/absent) does not.
 */
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json';

interface JsonSchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly items?: unknown;
  readonly additionalProperties?: unknown;
}

interface OperatorContractMethod {
  readonly id: string;
  readonly inputSchema?: JsonSchemaNode;
  readonly outputSchema?: JsonSchemaNode;
}

const METHODS = new Map(
  (operatorContract.operator.methods as OperatorContractMethod[]).map((method) => [method.id, method]),
);

/** Thrown by assertFixtureMatchesOperatorContract on any shape drift. */
export class ContractShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractShapeError';
  }
}

function walk(schema: JsonSchemaNode | undefined, sample: unknown, path: string): void {
  if (!schema) return;
  const where = path || '<root>';

  if (schema.properties) {
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
      throw new ContractShapeError(`${where}: expected an object per the operator-contract schema, got ${Array.isArray(sample) ? 'array' : typeof sample}`);
    }
    const rec = sample as Record<string, unknown>;

    for (const req of schema.required ?? []) {
      if (!(req in rec)) {
        throw new ContractShapeError(`${where}: schema-required field "${req}" is missing from the fixture`);
      }
    }

    const properties = schema.properties as Record<string, JsonSchemaNode>;
    for (const key of Object.keys(rec)) {
      const propSchema = properties[key];
      if (!propSchema) {
        if (schema.additionalProperties === false) {
          throw new ContractShapeError(`${where}: fixture field "${key}" is not a real schema property (the schema is closed)`);
        }
        continue;
      }
      walk(propSchema, rec[key], path ? `${path}.${key}` : key);
    }
    return;
  }

  if (schema.items) {
    if (!Array.isArray(sample)) {
      throw new ContractShapeError(`${where}: expected an array per the operator-contract schema, got ${typeof sample}`);
    }
    const itemSchema = schema.items as JsonSchemaNode;
    sample.forEach((item, i) => walk(itemSchema, item, `${path}[${i}]`));
  }
  // primitives / anyOf nodes: presence is already pinned by the parent object's
  // required-field check above; see the module header for why this doesn't descend
  // further (mirrors goodvibes.test.ts's assertConforms).
}

/**
 * Assert that `sample`, a fixture RESPONSE body, structurally matches
 * operator-contract.json's `outputSchema` for `methodId`: every schema-required field
 * is present at every level the sample populates, and no field is invented on a
 * closed (`additionalProperties:false`) schema node. Throws ContractShapeError (never
 * returns a boolean) so a caller gets an actionable message naming the exact path and
 * field that drifted.
 *
 * If `methodId` no longer exists in the installed operator-contract.json at all (a
 * rename/removal, not just a reshape), that is itself the drift signal and also
 * throws, a fixture bound to a dead method id is exactly the failure mode this
 * module exists to catch.
 */
export function assertFixtureMatchesOperatorContract(methodId: string, sample: unknown): void {
  const method = METHODS.get(methodId);
  if (!method) {
    throw new ContractShapeError(
      `"${methodId}" is not a method in the installed @pellux/goodvibes-sdk operator-contract.json. The fixture is bound to a method id the contract no longer declares.`,
    );
  }
  walk(method.outputSchema, sample, '');
}
