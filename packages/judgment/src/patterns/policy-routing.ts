import { orderedInUnit } from '../readings/bands.ts';

/** An action a hazard can trigger on its own: its action or a review. */
type Triggered<A extends string> = A | 'review';
/** What a screening decides: a triggered action, or pass when nothing triggered. */
export type PolicyAction<A extends string> = Triggered<A> | 'pass';

/** One named policy: the hazard probability that sends a case to review, the one that triggers the hazard's action, and the severity level that hardens a review. */
export interface PolicyThresholds {
  readonly review: number;
  readonly action: number;
  readonly severityLine: number;
}

/** How code turns the answers into one action: precedence, the severity action and the named policies. */
export interface PolicyRoutingSpec<A extends string> {
  /** Every action, highest precedence first; must include 'review', and end with 'pass'. */
  readonly precedence: readonly PolicyAction<A>[];
  /** The action a review becomes when severity crosses the line. */
  readonly severityAction: A;
  readonly policies: Readonly<Record<string, PolicyThresholds>>;
  readonly defaultPolicy: string;
}

/** A routing spec with the checklist name its errors report and the action each hazard triggers. */
export interface PolicyRouting<H extends string, A extends string> extends PolicyRoutingSpec<A> {
  readonly name: string;
  readonly hazardActions: Readonly<Record<H, A>>;
}

/** The named policy's thresholds; throws when the routing has no policy by that name. */
export function policyNamed(routing: PolicyRoutingSpec<string> & { readonly name: string }, policyName: string): PolicyThresholds {
  const policy = routing.policies[policyName];
  if (policy === undefined) throw new RangeError(`policy ${routing.name}: unknown policy "${policyName}"`);
  return policy;
}

/**
 * Throws unless precedence ranks every action with pass last, every policy's
 * thresholds are ordered and the default policy exists. Returns every action
 * the routing can decide.
 */
export function validateRouting<H extends string, A extends string>(routing: PolicyRouting<H, A>): ReadonlySet<string> {
  const { name, precedence } = routing;
  const actions = new Set<string>([...Object.values<A>(routing.hazardActions), routing.severityAction, 'review', 'pass']);
  const unranked = [...actions].find((action) => !precedence.includes(action as A));
  if (unranked !== undefined) throw new RangeError(`policy ${name}: precedence is missing "${unranked}"`);
  if (precedence.at(-1) !== 'pass') throw new RangeError(`policy ${name}: 'pass' must come last in precedence`);
  for (const [policyName, { review, action }] of Object.entries(routing.policies)) {
    if (!orderedInUnit([review, action])) throw new RangeError(`policy ${name}: ${policyName} needs 0 <= review <= action <= 1`);
  }
  policyNamed(routing, routing.defaultPolicy);
  return actions;
}

/** The actions a set of hazard probabilities triggers under one policy, before precedence picks one. */
function triggeredActions<H extends string, A extends string>(
  hazardActions: Readonly<Record<H, A>>,
  probabilities: Readonly<Record<H, number>>,
  policy: PolicyThresholds,
): Triggered<A>[] {
  return (Object.keys(hazardActions) as H[]).flatMap((hazard): Triggered<A>[] => {
    const p = probabilities[hazard];
    if (p >= policy.action) return [hazardActions[hazard]];
    return p >= policy.review ? ['review'] : [];
  });
}

/**
 * Decides one action from hazard probabilities and a severity level under a
 * named policy: each hazard triggers its action or a review, severity at or
 * above the line hardens a review into the severity action, and the
 * highest-precedence triggered action wins.
 */
export function makeRouter<H extends string, A extends string>(routing: PolicyRouting<H, A>) {
  return (probabilities: Readonly<Record<H, number>>, severity: number, policyName: string): PolicyAction<A> => {
    const policy = policyNamed(routing, policyName);
    const severe = severity >= policy.severityLine;
    const triggered = triggeredActions(routing.hazardActions, probabilities, policy).map((action) => (severe && action === 'review' ? routing.severityAction : action));
    return routing.precedence.find((action) => triggered.includes(action as Triggered<A>)) ?? 'pass';
  };
}
