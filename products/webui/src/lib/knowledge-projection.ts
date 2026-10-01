/**
 * knowledge-projection.ts, turning a projection target the daemon listed into a
 * request `knowledge.projection.render` will actually accept.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE VIEW: before the 1.19.1 SDK
 * re-pin, `OperatorMethodInput<'knowledge.projection.render'>` resolved to a
 * permissive `{ [k: string]: unknown }` fallback, so KnowledgeView built its
 * payload as `{ kind, ...(id ? { id } : {}), limit }` and the compiler had
 * nothing to say about it. The contract now describes the method properly, and
 * it is stricter than that payload in two independent ways:
 *
 *   1. `kind` is a closed union of seven values. Anything else, including a
 *      kind a NEWER daemon invents, is not a valid request.
 *   2. `id` is not uniformly optional. The input is a discriminated union: a
 *      bundle/dashboard/overview projection takes no id, while an
 *      issue/node/rollup/source projection REQUIRES one.
 *
 * So a source-kind target whose id could not be read produced a request the
 * daemon was always going to reject, and the view could only report that as a
 * generic failure. Both cases now fail loudly and specifically, and neither is
 * resolved by casting: casting `kind` back to the contract type would send the
 * rejected value anyway, which is the blindness the re-pin removes.
 */
import type { OperatorMethodInput } from './goodvibes';

export type ProjectionRenderInput = OperatorMethodInput<'knowledge.projection.render'>;
export type ProjectionKind = ProjectionRenderInput['kind'];
/** The kinds whose contract branch declares `id` required rather than optional. */
export type IdRequiredProjectionKind = Extract<ProjectionRenderInput, { id: string }>['kind'];

/**
 * Whether each kind's contract branch requires an id.
 *
 * The mapped type is doing real work in both directions, which is why this is
 * not a plain `Record<ProjectionKind, boolean>`:
 *   - every ProjectionKind must appear, so a kind ADDED by a future SDK is a
 *     missing-property compile error rather than a target that quietly stops
 *     being renderable;
 *   - each value's type is pinned to whether that kind is in
 *     IdRequiredProjectionKind, so an entry that disagrees with the contract is
 *     also a compile error. Without that, this table would be a hand-maintained
 *     opinion while `kindNeedsId` below, a type predicate, stayed free to lie.
 *
 * Both directions were verified by breaking them and watching tsc fail, not
 * assumed from reading the type.
 */
export const PROJECTION_KIND_NEEDS_ID: { [K in ProjectionKind]: K extends IdRequiredProjectionKind ? true : false } = {
  bundle: false,
  dashboard: false,
  overview: false,
  issue: true,
  node: true,
  rollup: true,
  source: true,
};

/** The kind as the contract spells it, or null if this build does not know it. */
export function asProjectionKind(kind: string): ProjectionKind | null {
  return Object.prototype.hasOwnProperty.call(PROJECTION_KIND_NEEDS_ID, kind) ? (kind as ProjectionKind) : null;
}

export function kindNeedsId(kind: ProjectionKind): kind is IdRequiredProjectionKind {
  return PROJECTION_KIND_NEEDS_ID[kind];
}

/** What a projection target reduces to once its kind has been checked. */
export interface ProjectionTargetLike {
  /** Verbatim from the daemon, NOT narrowed, see KnowledgeView's list rendering. */
  readonly kind: string;
  readonly renderableKind: ProjectionKind | null;
  readonly id?: string;
}

/**
 * Build the request, or throw a message that names the actual problem.
 *
 * Throwing rather than returning null is deliberate: both call sites are inside
 * a react-query mutation, so the message surfaces in that mutation's own
 * ErrorState next to the Render/Materialize buttons, which is where an operator
 * is already looking when the button they pressed did nothing.
 */
export function projectionPayload(selection: ProjectionTargetLike, limit = 25): ProjectionRenderInput {
  const kind = selection.renderableKind;
  if (!kind) {
    throw new Error(
      `This daemon offers a "${selection.kind}" projection, which this version of the web UI does not know how to request. Update the web UI to use it.`,
    );
  }
  if (kindNeedsId(kind)) {
    if (!selection.id) {
      throw new Error(
        `A "${kind}" projection has to name the item it projects, and this target arrived without an id. Nothing can be rendered from it.`,
      );
    }
    return { kind, id: selection.id, limit };
  }
  return { kind, limit };
}
